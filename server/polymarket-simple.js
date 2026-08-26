/**
 * Simplified Polymarket API Integration (Public Data Only)
 * 
 * This version doesn't require Ethereum wallets or authentication.
 * It only fetches publicly available market data.
 * 
 * Perfect for: Displaying predictions, odds, market sentiment
 * NOT for: Trading, placing bets, accessing private data
 */

const CLOB_ENDPOINT = process.env.POLYMARKET_CLOB_ENDPOINT || 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

/**
 * Sanitize error messages
 */
function sanitizeError(error) {
  const message = error.message?.toLowerCase() || '';
  if (message.includes('network')) return 'Network error';
  if (message.includes('timeout')) return 'Request timeout';
  return 'Failed to fetch data';
}

/**
 * Get Fed rate and mortgage-related prediction markets
 * @returns {Promise<Object>} Market data with predictions
 */
export async function getEconomicPredictions() {
  try {
    console.log('[Polymarket] Fetching economic predictions...');
    
    // Try to fetch a broader set of markets first
    const broadSearchResponse = await fetch(`${GAMMA_API}/markets?limit=500&closed=false`);
    let mortgageMarket = null;
    
    if (broadSearchResponse.ok) {
      const allAvailableMarkets = await broadSearchResponse.json();
      // Look for mortgage-related market
      const mortgageMatch = allAvailableMarkets.find(m => 
        m.question && (m.question.toLowerCase().includes('mortgage') || 
                      m.question.toLowerCase().includes('30-year') ||
                      m.slug === '30-year-mortgage-rate-below-6-by-december-31')
      );
      
      if (mortgageMatch) {
        mortgageMarket = mortgageMatch;
        console.log('[Polymarket] Found mortgage market:', mortgageMarket.question);
      } else {
        console.log('[Polymarket] No mortgage markets found in first 500 active markets');
      }
    }
    
  const searchTerms = [
    'fed rate cut',
    'federal reserve',
    'recession',
    'inflation',
    'unemployment'
  ];    const allMarkets = [];

    // Search for each term
    for (const term of searchTerms) {
      try {
        const response = await fetch(
          `${GAMMA_API}/markets?active=true&closed=false&query=${encodeURIComponent(term)}&limit=15`,
          {
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(5000)
          }
        );

        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data)) {
            // Log markets for debugging
            if (data.length > 0) {
              console.log(`[Polymarket] Found ${data.length} markets for "${term}"`);
              data.forEach(m => {
                console.log(`  - ${m.question}`);
              });
            }
            allMarkets.push(...data);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (err) {
        console.error(`[Polymarket] Search error for "${term}":`, err.message);
      }
    }

    // Remove duplicates and categorize
    const uniqueMarkets = Array.from(
      new Map(allMarkets.map(m => [m.condition_id || m.id, m])).values()
    );

    console.log('[Polymarket] Total unique markets found:', uniqueMarkets.length);

    const fedRateMarkets = [];
    const mortgageMarkets = [];
    const housingMarkets = [];
    const gdpMarkets = [];
    const recessionMarkets = [];
    const inflationMarkets = [];
    const unemploymentMarkets = [];
    
    // Add the specific mortgage market if we found it
    if (mortgageMarket) {
      // Parse the market data properly
      let parsedOutcomes = mortgageMarket.outcomes;
      if (typeof parsedOutcomes === 'string') {
        try {
          parsedOutcomes = JSON.parse(parsedOutcomes);
        } catch (e) {
          parsedOutcomes = [];
        }
      }

      let parsedOutcomePrices = mortgageMarket.outcomePrices;
      if (typeof parsedOutcomePrices === 'string') {
        try {
          parsedOutcomePrices = JSON.parse(parsedOutcomePrices);
        } catch (e) {
          parsedOutcomePrices = null;
        }
      }

      if (parsedOutcomePrices) {
        mortgageMarkets.push({
          id: mortgageMarket.id || mortgageMarket.condition_id,
          question: mortgageMarket.question,
          description: mortgageMarket.description,
          endDate: mortgageMarket.end_date_iso || mortgageMarket.endDate,
          volume: mortgageMarket.volume,
          liquidity: mortgageMarket.liquidity,
          outcomes: parsedOutcomes,
          outcomePrices: parsedOutcomePrices,
          active: mortgageMarket.active,
          image: mortgageMarket.image,
          url: `https://polymarket.com/event/${mortgageMarket.slug || mortgageMarket.id}`
        });
        console.log('[Polymarket] Added specific mortgage market:', mortgageMarket.question);
      }
    }

    uniqueMarkets.forEach(m => {
      const question = (m.question || '').toLowerCase();
      const description = (m.description || '').toLowerCase();
      const text = question + ' ' + description;

      // Skip markets without outcomePrices
      if (!m.outcomePrices) {
        return;
      }

      // Parse JSON strings if needed
      let parsedOutcomes = m.outcomes;
      if (typeof parsedOutcomes === 'string') {
        try {
          parsedOutcomes = JSON.parse(parsedOutcomes);
        } catch (e) {
          parsedOutcomes = [];
        }
      }

      let parsedOutcomePrices = m.outcomePrices;
      if (typeof parsedOutcomePrices === 'string') {
        try {
          parsedOutcomePrices = JSON.parse(parsedOutcomePrices);
        } catch (e) {
          console.error('[Polymarket] Failed to parse outcomePrices for:', m.question, e.message);
          parsedOutcomePrices = null;
        }
      }

      // Skip if parsing failed
      if (!parsedOutcomePrices) {
        return;
      }

      const marketData = {
        id: m.id || m.condition_id,
        question: m.question,
        description: m.description,
        endDate: m.end_date_iso || m.endDate,
        volume: m.volume,
        liquidity: m.liquidity,
        outcomes: parsedOutcomes,
        outcomePrices: parsedOutcomePrices,
        active: m.active,
        image: m.image,
        url: `https://polymarket.com/event/${m.slug || m.id}`
      };

      // Categorize based on question content
      const questionLower = question.toLowerCase();
      
      if (questionLower.includes('fed') && (questionLower.includes('rate cut') || questionLower.includes('decisions') || questionLower.includes('2025'))) {
        fedRateMarkets.push(marketData);
      }
      
      if (questionLower.includes('30') && questionLower.includes('year') && questionLower.includes('mortgage')) {
        mortgageMarkets.push(marketData);
      } else if (questionLower.includes('30-year') && questionLower.includes('mortgage')) {
        mortgageMarkets.push(marketData);
      } else if (questionLower.includes('mortgage rate') && questionLower.includes('below')) {
        mortgageMarkets.push(marketData);
      }

      if (questionLower.includes('housing emergency') || (questionLower.includes('trump') && questionLower.includes('housing'))) {
        housingMarkets.push(marketData);
      }

      if (questionLower.includes('gdp') && (questionLower.includes('growth') || questionLower.includes('q3'))) {
        gdpMarkets.push(marketData);
      }

      if (questionLower.includes('recession')) {
        recessionMarkets.push(marketData);
      }

      if (questionLower.includes('inflation') || questionLower.includes('cpi')) {
        inflationMarkets.push(marketData);
      }

      if (questionLower.includes('unemployment') || questionLower.includes('jobs')) {
        unemploymentMarkets.push(marketData);
      }
    });

    console.log('[Polymarket] Fed rate markets:', fedRateMarkets.length);
    console.log('[Polymarket] Mortgage markets:', mortgageMarkets.length);
    console.log('[Polymarket] Housing markets:', housingMarkets.length);
    console.log('[Polymarket] GDP markets:', gdpMarkets.length);
    console.log('[Polymarket] Recession markets:', recessionMarkets.length);
    console.log('[Polymarket] Inflation markets:', inflationMarkets.length);
    console.log('[Polymarket] Unemployment markets:', unemploymentMarkets.length);

    return {
      ok: true,
      fedRate: {
        markets: fedRateMarkets.slice(0, 5),
        count: fedRateMarkets.length
      },
      mortgage: {
        markets: mortgageMarkets.slice(0, 5),
        count: mortgageMarkets.length
      },
      housing: {
        markets: housingMarkets.slice(0, 5),
        count: housingMarkets.length
      },
      gdp: {
        markets: gdpMarkets.slice(0, 5),
        count: gdpMarkets.length
      },
      recession: {
        markets: recessionMarkets.slice(0, 5),
        count: recessionMarkets.length
      },
      inflation: {
        markets: inflationMarkets.slice(0, 5),
        count: inflationMarkets.length
      },
      unemployment: {
        markets: unemploymentMarkets.slice(0, 5),
        count: unemploymentMarkets.length
      },
      total: uniqueMarkets.length
    };

  } catch (error) {
    console.error('[Polymarket] Economic predictions error:', error);
    return {
      ok: false,
      error: sanitizeError(error),
      fedRate: { markets: [], count: 0 },
      mortgage: { markets: [], count: 0 }
    };
  }
}

/**
 * Get specific market with current odds
 * @param {string} marketId - The market ID
 * @returns {Promise<Object>} Market details with live odds
 */
export async function getMarketWithOdds(marketId) {
  try {
    if (!marketId || typeof marketId !== 'string') {
      return { ok: false, error: 'Invalid market ID' };
    }

    const response = await fetch(`${GAMMA_API}/markets/${marketId}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch market: ${response.status}`);
    }

    const market = await response.json();

    return {
      ok: true,
      market: {
        id: market.id,
        question: market.question,
        description: market.description,
        outcomes: market.outcomes,
        outcomePrices: market.outcomePrices, // Current odds (0-1 scale)
        volume: market.volume,
        liquidity: market.liquidity,
        endDate: market.end_date_iso,
        active: market.active,
        url: `https://polymarket.com/event/${market.slug || market.id}`
      }
    };

  } catch (error) {
    console.error('[Polymarket] Market details error:', error);
    return {
      ok: false,
      error: sanitizeError(error)
    };
  }
}

/**
 * Get simplified predictions for housing market dashboard
 * Returns just the key metrics you need for display
 */
export async function getHousingMarketPredictions() {
  try {
    const data = await getEconomicPredictions();
    
    if (!data.ok) {
      return data;
    }

    // Extract key predictions
    const predictions = {
      fedRateCut: null,
      mortgageRate: null,
      housingMarket: null,
      gdpGrowth: null,
      recession: null,
      inflation: null,
      unemployment: null,
      markets: []
    };

    // Find most relevant Fed rate prediction
    if (data.fedRate.markets.length > 0) {
      const topMarket = data.fedRate.markets[0];
      console.log('[Polymarket] Top Fed market:', {
        question: topMarket.question,
        outcomePricesType: typeof topMarket.outcomePrices,
        outcomePricesIsArray: Array.isArray(topMarket.outcomePrices),
        outcomePricesValue: topMarket.outcomePrices
      });
      
      let probability = null;
      if (topMarket.outcomePrices && Array.isArray(topMarket.outcomePrices) && topMarket.outcomePrices.length > 0) {
        probability = topMarket.outcomePrices[0];
      }
      
      predictions.fedRateCut = {
        question: topMarket.question,
        probability,
        endDate: topMarket.endDate,
        url: topMarket.url
      };
    }

    // Find most relevant mortgage prediction
    if (data.mortgage.markets.length > 0) {
      const topMarket = data.mortgage.markets[0];
      const probability = topMarket.outcomePrices && Array.isArray(topMarket.outcomePrices) && topMarket.outcomePrices.length > 0
        ? topMarket.outcomePrices[0]
        : null;
      
      predictions.mortgageRate = {
        question: topMarket.question,
        probability,
        endDate: topMarket.endDate,
        url: topMarket.url
      };
    }

    // Find housing market prediction
    if (data.housing.markets.length > 0) {
      const topMarket = data.housing.markets[0];
      const probability = topMarket.outcomePrices && Array.isArray(topMarket.outcomePrices) && topMarket.outcomePrices.length > 0
        ? topMarket.outcomePrices[0]
        : null;
      
      predictions.housingMarket = {
        question: topMarket.question,
        probability,
        endDate: topMarket.endDate,
        url: topMarket.url
      };
    }

    // Find GDP growth prediction
    if (data.gdp.markets.length > 0) {
      const topMarket = data.gdp.markets[0];
      const probability = topMarket.outcomePrices && Array.isArray(topMarket.outcomePrices) && topMarket.outcomePrices.length > 0
        ? topMarket.outcomePrices[0]
        : null;
      
      predictions.gdpGrowth = {
        question: topMarket.question,
        probability,
        endDate: topMarket.endDate,
        url: topMarket.url
      };
    }

    // Find recession prediction
    if (data.recession.markets.length > 0) {
      const topMarket = data.recession.markets[0];
      const probability = topMarket.outcomePrices && Array.isArray(topMarket.outcomePrices) && topMarket.outcomePrices.length > 0
        ? topMarket.outcomePrices[0]
        : null;
      
      predictions.recession = {
        question: topMarket.question,
        probability,
        endDate: topMarket.endDate,
        url: topMarket.url
      };
    }

    // Find inflation prediction
    if (data.inflation.markets.length > 0) {
      const topMarket = data.inflation.markets[0];
      const probability = topMarket.outcomePrices && Array.isArray(topMarket.outcomePrices) && topMarket.outcomePrices.length > 0
        ? topMarket.outcomePrices[0]
        : null;
      
      predictions.inflation = {
        question: topMarket.question,
        probability,
        endDate: topMarket.endDate,
        url: topMarket.url
      };
    }

    // Find unemployment prediction
    if (data.unemployment.markets.length > 0) {
      const topMarket = data.unemployment.markets[0];
      const probability = topMarket.outcomePrices && Array.isArray(topMarket.outcomePrices) && topMarket.outcomePrices.length > 0
        ? topMarket.outcomePrices[0]
        : null;
      
      predictions.unemployment = {
        question: topMarket.question,
        probability,
        endDate: topMarket.endDate,
        url: topMarket.url
      };
    }

    // Combine top markets
    predictions.markets = [
      ...data.fedRate.markets.slice(0, 2),
      ...data.mortgage.markets.slice(0, 1),
      ...data.housing.markets.slice(0, 1),
      ...data.recession.markets.slice(0, 1),
      ...data.inflation.markets.slice(0, 1)
    ];

    return {
      ok: true,
      predictions,
      fetchedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('[Polymarket] Housing predictions error:', error);
    return {
      ok: false,
      error: sanitizeError(error)
    };
  }
}
