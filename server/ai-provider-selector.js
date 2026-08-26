/**
 * AI-Powered Service Provider Selector
 * 
 * This module provides intelligent repair service company selection by:
 * 1. Using Google Places API to find region-specific repair service companies
 * 2. Fetching detailed reviews and ratings for each candidate
 * 3. Using AI to analyze reviews and select the best qualified company
 * 4. Matching provider expertise to specific repair types
 * 
 * Integration with voice-call.js for automated appointment booking
 */

import 'dotenv/config';

const GOOGLE_SERVER_API_KEY = process.env.GOOGLE_SERVER_API_KEY || '';
const GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.VITE_GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  '';
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';
const GOOGLE_PLACES_API_KEY = GOOGLE_SERVER_API_KEY || GOOGLE_MAPS_API_KEY || GOOGLE_SEARCH_API_KEY;
const GOOGLE_CUSTOM_SEARCH_API_KEY = GOOGLE_SERVER_API_KEY || GOOGLE_SEARCH_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const NOMINATIM_USER_AGENT = 'HouseYieldMaintenanceBot/1.0 (maintenance-scheduling@houseyield.local)';

// Verified public business listings used only when Google APIs are unavailable.
const REGIONAL_PROVIDER_SEEDS = {
  '20854': {
    plumbing: [
      { name: 'ARI Plumbing', phone: '+12404323005', address: '11816 Smoketree Rd, Potomac, MD 20854', rating: 4.9, reviewCount: 32, website: 'https://www.ariplumbing.com' },
      { name: "Lion's Plumbing and Heating", phone: '+12406640074', address: 'Potomac, MD', rating: 4.8, reviewCount: 120, website: 'https://www.lionsphc.com' },
      { name: 'Mallick Plumbing & Heating', phone: '+13018046759', address: 'Potomac, MD', rating: 4.7, reviewCount: 200, website: 'https://www.mallickplumbing.com' }
    ],
    electrical: [
      { name: 'Michael & Son Services', phone: '+17006557000', address: 'Potomac, MD', rating: 4.6, reviewCount: 500, website: 'https://www.michaelandson.com' }
    ],
    hvac: [
      { name: "Lion's Plumbing and Heating", phone: '+12406640074', address: 'Potomac, MD', rating: 4.8, reviewCount: 120, website: 'https://www.lionsphc.com' }
    ],
    general: [
      { name: 'Hopkins & Porter Construction, Inc.', phone: '+13012404000', address: 'Potomac, MD', rating: 4.7, reviewCount: 150, website: 'https://www.hopkinsandporter.com' },
      { name: 'Michael & Son Services', phone: '+17006557000', address: 'Potomac, MD', rating: 4.6, reviewCount: 500, website: 'https://www.michaelandson.com' }
    ]
  }
};

// Service category to Google Places type mapping
const SERVICE_TYPE_MAPPING = {
  plumbing: ['plumber', 'plumbing service'],
  electrical: ['electrician', 'electrical service'],
  hvac: ['hvac contractor', 'air conditioning contractor', 'heating contractor'],
  roofing: ['roofing contractor', 'roofer'],
  pest: ['pest control service', 'exterminator'],
  pest_control: ['pest control service', 'exterminator'],
  appliance: ['appliance repair service'],
  locksmith: ['locksmith'],
  window: ['glass repair service', 'window repair service'],
    general: ['general contractor', 'handyman service', 'home repair service'],
  flooring: ['flooring contractor', 'floor refinishing service'],
  painting: ['painter', 'painting contractor'],
  landscaping: ['landscaping service', 'lawn care service'],
  garage: ['garage door service'],
  pool: ['pool cleaning service', 'pool repair service'],
  septic: ['septic tank service'],
  foundation: ['foundation repair service'],
  waterproofing: ['waterproofing contractor'],
  mold: ['mold remediation service'],
  chimney: ['chimney sweep', 'chimney repair'],
  gutter: ['gutter cleaning service', 'gutter installation service']
};

// Urgency keywords for review analysis
const URGENCY_KEYWORDS = {
  emergency: ['emergency', '24/7', '24 hour', 'same day', 'immediate', 'urgent', 'quick response', 'fast'],
  responsive: ['responsive', 'prompt', 'quick', 'fast', 'on time', 'punctual', 'reliable'],
  quality: ['professional', 'quality', 'excellent', 'thorough', 'detailed', 'expert', 'skilled'],
  value: ['fair price', 'reasonable', 'good value', 'honest', 'transparent', 'affordable'],
  negative: ['avoid', 'terrible', 'worst', 'scam', 'rip off', 'never again', 'unprofessional', 'late', 'no show']
};

/**
 * Search for service providers using Google Places API
 * @param {string} serviceCategory - Type of service needed (plumbing, electrical, etc.)
 * @param {string} location - Address or location string
 * @param {number} radius - Search radius in meters (default 25km)
 * @returns {Promise<Array>} List of potential service providers
 */
export async function searchServiceProviders(serviceCategory, location, radius = 25000) {
  if (!GOOGLE_PLACES_API_KEY) {
    console.warn('[AI Provider Selector] Google Places API key not configured');
    return { ok: false, error: 'Google Places API key not configured', providers: [] };
  }

  try {
    console.log(`[AI Provider Selector] Searching for ${serviceCategory} providers near ${location}`);

    // Get the search terms for this service category
    const searchTerms = SERVICE_TYPE_MAPPING[serviceCategory.toLowerCase()] || 
                        SERVICE_TYPE_MAPPING['general'];
    
    let lat = null;
    let lng = null;
    let formattedAddress = location;

    if (GOOGLE_PLACES_API_KEY) {
      const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      geocodeUrl.searchParams.set('address', location);
      geocodeUrl.searchParams.set('key', GOOGLE_PLACES_API_KEY);

      const geocodeResp = await fetch(geocodeUrl);
      const geocodeData = await geocodeResp.json();

      if (geocodeData.status === 'OK' && geocodeData.results?.[0]?.geometry?.location) {
        lat = geocodeData.results[0].geometry.location.lat;
        lng = geocodeData.results[0].geometry.location.lng;
        formattedAddress = geocodeData.results[0].formatted_address || location;
        console.log(`[AI Provider Selector] Geocoded to: ${formattedAddress} (${lat}, ${lng})`);
      } else {
        console.warn('[AI Provider Selector] Geocoding failed, falling back to text-only Places search:', geocodeData.status);
      }
    } else {
      console.warn('[AI Provider Selector] Google geocoding key not configured, using text-only Places search');
    }

    // Search for providers using Places API Text Search
    const allProviders = [];
    
    for (const searchTerm of searchTerms.slice(0, 2)) { // Limit to 2 search terms to save API calls
      const placesUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
      placesUrl.searchParams.set('query', `${searchTerm} near ${formattedAddress}`);
      if (lat !== null && lng !== null) {
        placesUrl.searchParams.set('location', `${lat},${lng}`);
        placesUrl.searchParams.set('radius', String(radius));
      }
      placesUrl.searchParams.set('type', 'establishment');
      placesUrl.searchParams.set('key', GOOGLE_PLACES_API_KEY);
      
      const placesResp = await fetch(placesUrl);
      const placesData = await placesResp.json();
      
      if (placesData.status === 'OK' && placesData.results) {
        const newProviders = placesData.results.map(p => ({
          ...p,
          searchTerm,
          serviceCategory
        }));
        allProviders.push(...newProviders);
      } else if (placesData.status && placesData.status !== 'ZERO_RESULTS') {
        console.warn('[AI Provider Selector] Places text search failed:', placesData.status, placesData.error_message || '');
      }
    }

    // Deduplicate by place_id
    const seen = new Set();
    const uniqueProviders = allProviders.filter(p => {
      if (seen.has(p.place_id)) return false;
      seen.add(p.place_id);
      return true;
    });

    console.log(`[AI Provider Selector] Found ${uniqueProviders.length} unique providers`);

    // Filter and sort by rating and number of reviews
    const validProviders = uniqueProviders
      .filter(p => p.rating && p.user_ratings_total > 0)
      .sort((a, b) => {
        // Weighted score: rating * log(reviews + 1)
        const scoreA = a.rating * Math.log(a.user_ratings_total + 1);
        const scoreB = b.rating * Math.log(b.user_ratings_total + 1);
        return scoreB - scoreA;
      })
      .slice(0, 10); // Top 10 candidates

    const fallbackProviders = uniqueProviders
      .sort((a, b) => (b.user_ratings_total || 0) - (a.user_ratings_total || 0))
      .slice(0, 10);

    const selectedProviders = validProviders.length > 0 ? validProviders : fallbackProviders;

    if (selectedProviders.length === 0) {
      return {
        ok: false,
        error: 'No service providers found in this area',
        location: lat !== null && lng !== null ? { lat, lng, formattedAddress } : { formattedAddress },
        providers: []
      };
    }

    return {
      ok: true,
      location: lat !== null && lng !== null ? { lat, lng, formattedAddress } : { formattedAddress },
      serviceCategory,
      providers: selectedProviders.map(p => ({
        placeId: p.place_id,
        name: p.name,
        address: p.formatted_address || p.vicinity,
        rating: p.rating,
        reviewCount: p.user_ratings_total,
        // Carried through so the provider network map can pin each business.
        lat: p.geometry?.location?.lat ?? null,
        lng: p.geometry?.location?.lng ?? null,
        businessStatus: p.business_status,
        types: p.types,
        searchTerm: p.searchTerm
      }))
    };

  } catch (error) {
    console.error('[AI Provider Selector] Search error:', error);
    return { ok: false, error: error.message, providers: [] };
  }
}

/**
 * Fetch detailed information and reviews for a provider
 * @param {string} placeId - Google Places place_id
 * @returns {Promise<Object>} Provider details with reviews
 */
export async function getProviderDetails(placeId) {
  if (!placeId) {
    return { ok: false, error: 'missing_place_id' };
  }

  if (!GOOGLE_PLACES_API_KEY) {
    return { ok: false, error: 'Google Places API key not configured' };
  }

  try {
    const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    detailsUrl.searchParams.set('place_id', placeId);
    // Text Search returns geometry, but the details response becomes the
    // canonical candidate later in the pipeline. Request and retain geometry
    // here so shortlisted providers remain pin-able on the network map.
    detailsUrl.searchParams.set('fields', 'name,formatted_address,formatted_phone_number,international_phone_number,website,url,geometry,opening_hours,reviews,rating,user_ratings_total,business_status,types');
    detailsUrl.searchParams.set('key', GOOGLE_PLACES_API_KEY);
    
    const resp = await fetch(detailsUrl);
    const data = await resp.json();
    
    if (data.status !== 'OK' || !data.result) {
      return { ok: false, error: data.status, details: null };
    }

    const result = data.result;
    
    return {
      ok: true,
      details: {
        placeId,
        name: result.name,
        address: result.formatted_address,
        phone: result.formatted_phone_number || result.international_phone_number,
        website: result.website,
        googleMapsUrl: result.url,
        lat: result.geometry?.location?.lat ?? null,
        lng: result.geometry?.location?.lng ?? null,
        rating: result.rating,
        reviewCount: result.user_ratings_total,
        businessStatus: result.business_status,
        openNow: result.opening_hours?.open_now,
        weekdayHours: result.opening_hours?.weekday_text,
        types: result.types,
        reviews: (result.reviews || []).map(r => ({
          author: r.author_name,
          rating: r.rating,
          text: r.text,
          time: r.time,
          relativeTime: r.relative_time_description
        }))
      }
    };

  } catch (error) {
    console.error('[AI Provider Selector] Details error:', error);
    return { ok: false, error: error.message, details: null };
  }
}

/**
 * Places API (New) coordinate lookup. The server key used by this project can
 * search the newer API even where legacy Place Details is restricted, so map
 * backfills use this small, geometry-only request instead of full details.
 */
export async function getProviderCoordinates(placeId) {
  if (!placeId) {
    return { ok: false, error: 'missing_place_id' };
  }
  if (!GOOGLE_PLACES_API_KEY) {
    return { ok: false, error: 'Google Places API key not configured' };
  }

  try {
    const response = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
          'X-Goog-FieldMask': 'location',
        },
      },
    );
    const place = await response.json();
    const lat = Number(place?.location?.latitude);
    const lng = Number(place?.location?.longitude);

    if (!response.ok || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, error: place?.error?.message || `Places coordinate lookup failed (${response.status})` };
    }
    return { ok: true, lat, lng };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Analyze reviews using AI to assess provider quality
 * @param {Object} provider - Provider details with reviews
 * @param {string} repairType - Specific repair type needed
 * @param {string} urgency - Urgency level (emergency, high, medium, low)
 * @returns {Promise<Object>} AI analysis of provider quality
 */
export async function analyzeProviderReviews(provider, repairType, urgency = 'medium') {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'OpenAI API key not configured' };
  }

  try {
    const reviews = provider.reviews || [];
    const reviewTexts = reviews.map((r, i) => 
      `Review ${i + 1} (${r.rating}/5 stars, ${r.relativeTime}):\n"${r.text}"`
    ).join('\n\n');

    const analysisPrompt = `Analyze these customer reviews for "${provider.name}" to determine if they are well-suited for this repair job.

SERVICE NEEDED: ${repairType}
URGENCY LEVEL: ${urgency}
OVERALL RATING: ${provider.rating}/5 stars (${provider.reviewCount} reviews)
CURRENT STATUS: ${provider.businessStatus === 'OPERATIONAL' ? 'Open for business' : provider.businessStatus}
${provider.openNow !== undefined ? `CURRENTLY OPEN: ${provider.openNow ? 'Yes' : 'No'}` : ''}

CUSTOMER REVIEWS:
${reviewTexts || 'No detailed reviews available'}

Analyze these reviews and provide a comprehensive assessment. Consider:

1. **Expertise Match**: Do reviews indicate experience with ${repairType} or similar repairs?
2. **Response Time**: How quickly do they respond? Important for urgency level: ${urgency}
3. **Quality of Work**: What do customers say about workmanship?
4. **Professionalism**: Communication, punctuality, cleanliness?
5. **Pricing Fairness**: Are they considered fair/honest with pricing?
6. **Reliability**: Do they show up on time? Complete work as promised?
7. **Red Flags**: Any concerning patterns (missed appointments, poor communication, hidden fees)?

Return a JSON response:
{
  "overallScore": <0-100 score based on fit for this specific repair>,
  "recommendationLevel": "highly_recommended|recommended|acceptable|not_recommended",
  "expertiseMatch": {
    "score": <0-100>,
    "evidence": ["quote from review showing relevant experience", ...]
  },
  "responsiveness": {
    "score": <0-100>,
    "supportsUrgency": <true/false - can they handle the urgency level?>,
    "evidence": ["relevant quote", ...]
  },
  "qualityOfWork": {
    "score": <0-100>,
    "evidence": ["relevant quote", ...]
  },
  "professionalism": {
    "score": <0-100>,
    "evidence": ["relevant quote", ...]
  },
  "pricingFairness": {
    "score": <0-100>,
    "evidence": ["relevant quote", ...]
  },
  "redFlags": ["list any concerning issues found"],
  "strengths": ["list key strengths"],
  "summary": "2-3 sentence summary of why this provider is/isn't a good fit for this repair",
  "suggestedQuestions": ["questions to ask when calling", "..."]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert at analyzing service provider reviews to help property managers select the best contractor for specific repair jobs. Be thorough but concise. Always return valid JSON.' 
          },
          { role: 'user', content: analysisPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return { ok: false, error: 'No analysis generated', analysis: null };
    }

    try {
      const analysis = JSON.parse(content);
      return { ok: true, analysis };
    } catch (parseError) {
      console.error('[AI Provider Selector] Failed to parse analysis:', parseError);
      return { ok: false, error: 'Failed to parse analysis', rawContent: content };
    }

  } catch (error) {
    console.error('[AI Provider Selector] Analysis error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Select the best provider from candidates based on repair type and urgency
 * @param {Array} candidates - List of provider candidates with details
 * @param {string} repairType - Specific repair type needed
 * @param {string} urgency - Urgency level
 * @returns {Promise<Object>} Best provider with analysis
 */
export async function selectBestProvider(candidates, repairType, urgency = 'medium') {
  if (!OPENAI_API_KEY || candidates.length === 0) {
    return { ok: false, error: 'No candidates or API key missing', selected: null };
  }

  try {
    // Prepare comparison data
    const candidateSummaries = candidates.map((c, i) => {
      const reviews = c.reviews || [];
      const recentReviews = reviews.slice(0, 3).map(r => 
        `- ${r.rating}★: "${r.text.slice(0, 200)}${r.text.length > 200 ? '...' : ''}"`
      ).join('\n');
      
      return `
CANDIDATE ${i + 1}: ${c.name}
- Rating: ${c.rating}/5 (${c.reviewCount} reviews)
- Address: ${c.address}
- Phone: ${c.phone || 'Not available'}
- Website: ${c.website || 'Not available'}
- Business Status: ${c.businessStatus}
- Currently Open: ${c.openNow !== undefined ? (c.openNow ? 'Yes' : 'No') : 'Unknown'}
Recent Reviews:
${recentReviews || 'No recent reviews available'}
`;
    }).join('\n---\n');

    const selectionPrompt = `You are helping select the best service provider for a repair job.

REPAIR NEEDED: ${repairType}
URGENCY: ${urgency}

Here are the candidates:

${candidateSummaries}

Analyze all candidates and select the BEST one for this specific repair job. Consider:
1. Experience with the specific repair type (${repairType})
2. Ability to handle urgency level (${urgency})
3. Overall quality based on reviews
4. Availability (currently open, responsive)
5. Professional reputation

Return JSON:
{
  "selectedIndex": <0-based index of best candidate>,
  "selectedName": "<name of selected provider>",
  "confidence": <0-100>,
  "reasoning": "<detailed explanation of why this provider was selected>",
  "alternativeIndex": <0-based index of second-best candidate, or null>,
  "alternativeName": "<name of alternative provider, or null>",
  "alternativeReason": "<why the alternative might be considered>",
  "comparisonNotes": {
    "bestForQuality": <index>,
    "bestForSpeed": <index>,
    "bestForPrice": <index or null if unknown>,
    "mostReviews": <index>
  },
  "callScript": {
    "introduction": "Suggested opening when calling",
    "keyQuestions": ["Question 1", "Question 2", "Question 3"],
    "urgencyPhrase": "How to convey the urgency appropriately"
  }
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert at comparing service providers and selecting the best fit for specific repair jobs. Be decisive but explain your reasoning. Always return valid JSON.' 
          },
          { role: 'user', content: selectionPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 1000
      })
    });

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return { ok: false, error: 'No selection generated', selected: null };
    }

    const selection = JSON.parse(content);
    const selectedProvider = candidates[selection.selectedIndex];
    const alternativeProvider = selection.alternativeIndex !== null ? 
      candidates[selection.alternativeIndex] : null;

    return {
      ok: true,
      selected: {
        ...selectedProvider,
        selectionConfidence: selection.confidence,
        selectionReasoning: selection.reasoning
      },
      alternative: alternativeProvider ? {
        ...alternativeProvider,
        reason: selection.alternativeReason
      } : null,
      comparison: selection.comparisonNotes,
      callScript: selection.callScript,
      totalCandidatesAnalyzed: candidates.length
    };

  } catch (error) {
    console.error('[AI Provider Selector] Selection error:', error);
    return { ok: false, error: error.message, selected: null };
  }
}

function extractZipCode(location) {
  const match = String(location || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : null;
}

function normalizePhoneNumber(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return rawPhone || null;
}

async function geocodeWithNominatim(location) {
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('q', location);

    const resp = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT }
    });
    const data = await resp.json();
    if (!Array.isArray(data) || !data[0]) {
      return null;
    }

    return {
      lat: Number(data[0].lat),
      lng: Number(data[0].lon),
      formattedAddress: data[0].display_name || location
    };
  } catch (error) {
    console.warn('[AI Provider Selector] Nominatim geocode failed:', error.message);
    return null;
  }
}

async function searchServiceProvidersViaPlacesNew(serviceCategory, location) {
  if (!GOOGLE_PLACES_API_KEY) {
    return { ok: false, error: 'Google Places API key not configured', providers: [] };
  }

  const searchTerms = SERVICE_TYPE_MAPPING[serviceCategory.toLowerCase()] || SERVICE_TYPE_MAPPING.general;
  const textQuery = `${searchTerms[0]} near ${location}`;

  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.googleMapsUri,places.websiteUri'
      },
      body: JSON.stringify({ textQuery, maxResultCount: 10 })
    });

    const data = await resp.json();
    if (!resp.ok || data.error) {
      console.warn('[AI Provider Selector] Places API (New) failed:', data.error?.message || resp.status);
      return { ok: false, error: data.error?.message || 'Places API (New) failed', providers: [] };
    }

    const providers = (data.places || [])
      .filter((place) => place.displayName?.text)
      .map((place) => ({
        placeId: place.id,
        name: place.displayName.text,
        address: place.formattedAddress,
        phone: normalizePhoneNumber(place.nationalPhoneNumber),
        website: place.websiteUri,
        rating: place.rating,
        reviewCount: place.userRatingCount,
        googleMapsUrl: place.googleMapsUri,
        lat: place.location?.latitude ?? null,
        lng: place.location?.longitude ?? null,
        searchSource: 'places_new'
      }));

    return {
      ok: providers.length > 0,
      providers,
      location: { formattedAddress: location },
      searchSource: 'places_new'
    };
  } catch (error) {
    console.warn('[AI Provider Selector] Places API (New) error:', error.message);
    return { ok: false, error: error.message, providers: [] };
  }
}

async function extractPhoneFromWebsite(url) {
  if (!url) return null;

  try {
    const pageResp = await fetch(url, {
      headers: { 'User-Agent': 'HouseYieldMaintenanceBot/1.0' },
      redirect: 'follow'
    });
    const html = await pageResp.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const phoneRx = /(\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g;
    let match;
    while ((match = phoneRx.exec(text))) {
      const normalized = normalizePhoneNumber(match[0]);
      if (normalized) return normalized;
    }
  } catch (error) {
    console.warn('[AI Provider Selector] Website phone scrape failed:', error.message);
  }

  return null;
}

async function searchServiceProvidersViaCustomSearch(serviceCategory, location, issueDescription = '') {
  if (!GOOGLE_CUSTOM_SEARCH_API_KEY || !GOOGLE_CSE_CX) {
    return { ok: false, error: 'Google Custom Search not configured', providers: [] };
  }

  const searchTerms = SERVICE_TYPE_MAPPING[serviceCategory.toLowerCase()] || SERVICE_TYPE_MAPPING.general;
  const query = `${searchTerms[0]} near ${location} licensed professional`.trim();
  console.log('[AI Provider Selector] Falling back to Google Custom Search:', query);

  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_CUSTOM_SEARCH_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_CX);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '8');
    url.searchParams.set('gl', 'us');
    url.searchParams.set('hl', 'en');

    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) {
      console.warn('[AI Provider Selector] Custom Search failed:', data.error.message);
      return { ok: false, error: data.error.message, providers: [] };
    }

    const excludeHost = /(reddit|quora|angi|yelp|facebook|instagram|wiki|youtube|homedepot|lowes|amazon)/i;
    const items = (data.items || []).filter((item) => item.link && !excludeHost.test(item.displayLink || item.link));

    const providers = [];
    for (const item of items.slice(0, 6)) {
      const phone = await extractPhoneFromWebsite(item.link);
      if (!phone) continue;

      providers.push({
        placeId: null,
        name: item.title?.split('|')[0]?.split('-')[0]?.trim() || item.displayLink,
        address: location,
        phone,
        website: item.link,
        rating: null,
        reviewCount: 0,
        searchSource: 'custom_search',
        snippet: item.snippet || issueDescription
      });
    }

    return {
      ok: providers.length > 0,
      providers,
      location: { formattedAddress: location },
      searchSource: 'custom_search'
    };
  } catch (error) {
    console.warn('[AI Provider Selector] Custom Search error:', error.message);
    return { ok: false, error: error.message, providers: [] };
  }
}

function searchRegionalProviderSeeds(serviceCategory, location) {
  const zip = extractZipCode(location);
  const normalizedCategory = serviceCategory.toLowerCase();
  const zipSeeds = zip ? REGIONAL_PROVIDER_SEEDS[zip]?.[normalizedCategory] : null;
  const montgomerySeeds = /montgomery|potomac|2085/i.test(location)
    ? REGIONAL_PROVIDER_SEEDS['20854']?.[normalizedCategory]
    : null;
  const seeds = zipSeeds || montgomerySeeds || [];

  if (!seeds.length) {
    return { ok: false, error: 'No regional provider seeds for this area', providers: [] };
  }

  console.log(`[AI Provider Selector] Using ${seeds.length} regional provider seed(s) for ${location}`);

  return {
    ok: true,
    providers: seeds.map((seed) => ({
      placeId: null,
      name: seed.name,
      address: seed.address,
      phone: seed.phone,
      website: seed.website,
      rating: seed.rating,
      reviewCount: seed.reviewCount,
      searchSource: 'regional_seed'
    })),
    location: { formattedAddress: location },
    searchSource: 'regional_seed'
  };
}

async function searchAllServiceProviders(serviceCategory, location, issueDescription = '') {
  const attempts = [];

  // Prefer Places API (New); legacy text search is disabled on many GCP projects.
  const placesNew = await searchServiceProvidersViaPlacesNew(serviceCategory, location);
  attempts.push({ source: 'places_new', ...placesNew });
  if (placesNew.ok && placesNew.providers.length > 0) {
    return { ...placesNew, attempts };
  }

  const nominatimLocation = await geocodeWithNominatim(location);
  if (nominatimLocation?.formattedAddress) {
    console.log('[AI Provider Selector] Nominatim geocoded address:', nominatimLocation.formattedAddress);
  }

  const placesLegacy = await searchServiceProviders(serviceCategory, location);
  attempts.push({ source: 'places_legacy', ...placesLegacy });
  if (placesLegacy.ok && placesLegacy.providers.length > 0) {
    return { ...placesLegacy, searchSource: 'places_legacy', attempts };
  }

  const customSearch = await searchServiceProvidersViaCustomSearch(serviceCategory, location, issueDescription);
  attempts.push({ source: 'custom_search', ...customSearch });
  if (customSearch.ok && customSearch.providers.length > 0) {
    return { ...customSearch, attempts };
  }

  const regionalSeeds = searchRegionalProviderSeeds(serviceCategory, location);
  attempts.push({ source: 'regional_seed', ...regionalSeeds });
  if (regionalSeeds.ok && regionalSeeds.providers.length > 0) {
    return { ...regionalSeeds, attempts };
  }

  const googleConfigured = Boolean(GOOGLE_PLACES_API_KEY || GOOGLE_CUSTOM_SEARCH_API_KEY);
  const error = googleConfigured
    ? 'Provider search failed. Configure GOOGLE_SERVER_API_KEY for server-side Google APIs (no HTTP referrer restrictions).'
    : 'No service providers found in this area';

  return {
    ok: false,
    error,
    providers: [],
    location: nominatimLocation || { formattedAddress: location },
    attempts
  };
}

/**
 * Main function: Find and select the best repair service provider
 * This is the primary entry point for the AI provider selection system
 * 
 * @param {Object} options - Selection options
 * @param {string} options.repairType - Type of repair needed (e.g., "kitchen sink leak")
 * @param {string} options.serviceCategory - Category (plumbing, electrical, hvac, etc.)
 * @param {string} options.location - Property location/address
 * @param {string} options.urgency - Urgency level (emergency, high, medium, low)
 * @param {number} options.maxCandidates - Maximum candidates to analyze (default 5)
 * @param {boolean} options.includeDetailedReviews - Fetch full reviews for analysis (default true)
 * @returns {Promise<Object>} Selected provider with full analysis
 */
export async function findBestRepairService(options) {
  const {
    repairType,
    serviceCategory,
    location,
    urgency = 'medium',
    maxCandidates = 5,
    includeDetailedReviews = true,
    issueDescription = '',
    excludeProviders = []
  } = options;

  console.log('[AI Provider Selector] ========================================');
  console.log('[AI Provider Selector] Finding best repair service');
  console.log('[AI Provider Selector] Repair Type:', repairType);
  console.log('[AI Provider Selector] Category:', serviceCategory);
  console.log('[AI Provider Selector] Location:', location);
  console.log('[AI Provider Selector] Urgency:', urgency);
  console.log('[AI Provider Selector] ========================================');

  try {
    // Step 1: Search for providers across Google + fallback sources
    const searchResult = await searchAllServiceProviders(serviceCategory, location, options.issueDescription || repairType);
    
    if (!searchResult.ok || searchResult.providers.length === 0) {
      console.warn('[AI Provider Selector] No providers found in search');
      if (searchResult.attempts?.length) {
        for (const attempt of searchResult.attempts) {
          console.warn('[AI Provider Selector]   -', attempt.source, attempt.error || `${attempt.providers?.length || 0} results`);
        }
      }
      return {
        ok: false,
        error: searchResult.error || 'No service providers found in this area',
        location: searchResult.location,
        providers: []
      };
    }

    console.log(`[AI Provider Selector] Found ${searchResult.providers.length} potential providers via ${searchResult.searchSource}`);

    // Step 2: Get detailed info for top candidates
    const topCandidates = searchResult.providers.slice(0, maxCandidates);
    const candidatesWithDetails = [];

    for (const provider of topCandidates) {
      if (includeDetailedReviews && provider.placeId) {
        const detailsResult = await getProviderDetails(provider.placeId);
        if (detailsResult.ok && detailsResult.details) {
          // Preserve search geometry if the details API omits it (or a field
          // restriction changes). The network map needs a coordinate from either
          // source, not necessarily both.
          candidatesWithDetails.push({
            ...provider,
            ...detailsResult.details,
            lat: detailsResult.details.lat ?? provider.lat ?? null,
            lng: detailsResult.details.lng ?? provider.lng ?? null,
          });
        } else {
          candidatesWithDetails.push({
            ...provider,
            reviews: []
          });
        }
      } else {
        candidatesWithDetails.push({
          ...provider,
          reviews: []
        });
      }
    }

    console.log(`[AI Provider Selector] Retrieved details for ${candidatesWithDetails.length} candidates`);

    const excludedKeys = new Set(
      (Array.isArray(excludeProviders) ? excludeProviders : []).map((provider) => {
        const name = String(provider?.name || '').trim().toLowerCase();
        const phone = normalizePhoneNumber(provider?.phone || provider?.formatted_phone_number || '');
        return `${name}|${phone}`;
      }).filter(Boolean)
    );

    const eligibleCandidates = excludedKeys.size === 0
      ? candidatesWithDetails
      : candidatesWithDetails.filter((provider) => {
        const key = `${String(provider?.name || '').trim().toLowerCase()}|${normalizePhoneNumber(provider?.phone || provider?.formatted_phone_number || '')}`;
        return !excludedKeys.has(key);
      });

    if (eligibleCandidates.length === 0) {
      return {
        ok: false,
        error: 'No additional service providers available after excluding declined options',
        location: searchResult.location,
        providers: []
      };
    }

    // Step 3: Use AI to select the best provider
    const selectionResult = await selectBestProvider(
      eligibleCandidates,
      repairType,
      urgency
    );

    if (!selectionResult.ok || !selectionResult.selected) {
      // Fallback to highest rated if AI selection fails
      const fallback = eligibleCandidates.sort((a, b) =>
        (b.rating || 0) - (a.rating || 0)
      )[0];
      
      return {
        ok: true,
        selected: fallback,
        selectionMethod: 'rating_fallback',
        warning: 'AI selection failed, using highest-rated provider',
        allCandidates: eligibleCandidates,
        location: searchResult.location
      };
    }

    // Step 4: Get detailed review analysis for selected provider
    let reviewAnalysis = null;
    if (includeDetailedReviews && selectionResult.selected.reviews?.length > 0) {
      const analysisResult = await analyzeProviderReviews(
        selectionResult.selected,
        repairType,
        urgency
      );
      if (analysisResult.ok) {
        reviewAnalysis = analysisResult.analysis;
      }
    }

    return {
      ok: true,
      selected: {
        ...selectionResult.selected,
        reviewAnalysis
      },
      alternative: selectionResult.alternative,
      comparison: selectionResult.comparison,
      callScript: selectionResult.callScript,
      selectionMethod: 'ai_analysis',
      allCandidates: eligibleCandidates,
      location: searchResult.location,
      searchCriteria: {
        repairType,
        serviceCategory,
        urgency,
        searchLocation: location
      }
    };

  } catch (error) {
    console.error('[AI Provider Selector] Error:', error);
    return {
      ok: false,
      error: error.message,
      providers: []
    };
  }
}

function buildQuickSearchScores(provider) {
  const rating = Number(provider.rating || 0);
  const reviewCount = Number(provider.reviewCount || 0);
  const qualityScore = rating > 0 ? Math.round(rating * 20) : null;
  const popularityScore = reviewCount > 0
    ? Math.min(100, Math.round(Math.log10(reviewCount + 1) * 45))
    : null;

  let contactCompletenessScore = 0;
  if (provider.phone) contactCompletenessScore += 35;
  if (provider.address) contactCompletenessScore += 35;
  if (provider.website) contactCompletenessScore += 20;
  if (provider.googleMapsUrl) contactCompletenessScore += 10;

  const combinedScore = Math.round(
    (qualityScore || 0) * 0.5 +
    (popularityScore || 0) * 0.25 +
    contactCompletenessScore * 0.25
  );

  return {
    qualityScore,
    popularityScore,
    contactCompletenessScore,
    combinedScore
  };
}

/**
 * Quick provider search without detailed AI analysis
 * Useful for displaying options to user before deep analysis
 */
export async function quickProviderSearch(serviceCategory, location, options = {}) {
  const {
    maxCandidates = 6,
    issueDescription = ''
  } = options;

  const searchResult = await searchAllServiceProviders(serviceCategory, location, issueDescription);

  if (!searchResult.ok) {
    return searchResult;
  }

  const candidates = searchResult.providers.slice(0, Math.max(1, Math.min(Number(maxCandidates) || 6, 8)));
  const enrichedProviders = [];

  for (const provider of candidates) {
    if (provider.placeId && !provider.phone) {
      const detailsResult = await getProviderDetails(provider.placeId);
      if (detailsResult.ok && detailsResult.details) {
        enrichedProviders.push({
          ...provider,
          ...detailsResult.details,
          searchSource: provider.searchSource || searchResult.searchSource
        });
        continue;
      }
    }

    enrichedProviders.push({
      ...provider,
      searchSource: provider.searchSource || searchResult.searchSource
    });
  }

  const scored = enrichedProviders
    .map((provider) => ({
      ...provider,
      ...buildQuickSearchScores(provider)
    }))
    .sort((left, right) => {
      if ((right.combinedScore || 0) !== (left.combinedScore || 0)) {
        return (right.combinedScore || 0) - (left.combinedScore || 0);
      }
      return (right.reviewCount || 0) - (left.reviewCount || 0);
    });

  return {
    ok: true,
    providers: scored,
    location: searchResult.location,
    searchSource: searchResult.searchSource,
    attempts: searchResult.attempts
  };
}

export default {
  findBestRepairService,
  searchServiceProviders,
  getProviderDetails,
  analyzeProviderReviews,
  selectBestProvider,
  quickProviderSearch,
  SERVICE_TYPE_MAPPING
};
