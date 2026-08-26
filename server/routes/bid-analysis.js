/**
 * AI Bid Analysis — Google Custom Search + GPT-4o
 * Scores each contractor bid by quality, credibility, and value (quality/cost ratio).
 * Returns bids sorted by valueScore descending with rank assigned.
 *
 * Required env vars: OPENAI_API_KEY, GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_CX
 */

import express from 'express';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const router = express.Router();

let openai;
try {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} catch {
  // Will fail gracefully per-request if key is missing
}

/**
 * Run a Google Custom Search for contractor reputation signals.
 * Returns up to 5 result snippets.
 */
async function searchContractorReputation(companyName, renovationType) {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;

  if (!key || !cx) {
    console.warn('[BidAnalysis] GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX not set');
    return [];
  }

  const query = encodeURIComponent(
    `"${companyName}" contractor reviews ${renovationType} site:yelp.com OR site:google.com OR site:bbb.org OR site:angi.com OR site:houzz.com`
  );
  const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${query}&num=5`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn('[BidAnalysis] Google Search returned', resp.status);
      return [];
    }
    const data = await resp.json();
    return (data.items || []).map(item => ({
      platform: extractPlatformName(item.link),
      title: item.title,
      snippet: item.snippet,
      url: item.link
    }));
  } catch (err) {
    console.warn('[BidAnalysis] Google Search error:', err.message);
    return [];
  }
}

function extractPlatformName(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    const knownPlatforms = {
      'yelp.com': 'Yelp',
      'google.com': 'Google',
      'bbb.org': 'BBB',
      'angi.com': 'Angi',
      'houzz.com': 'Houzz',
      'homeadvisor.com': 'HomeAdvisor',
      'thumbtack.com': 'Thumbtack'
    };
    return knownPlatforms[hostname] || hostname;
  } catch {
    return 'Web';
  }
}

/**
 * Score a single bid using GPT-4o given web research results.
 */
async function scoreBidWithAI(bid, listingDetails, searchResults) {
  if (!openai) {
    throw new Error('OpenAI client not initialized — OPENAI_API_KEY may be missing');
  }

  const snippetsText = searchResults.length > 0
    ? searchResults.map(r => `${r.platform} — ${r.title}: ${r.snippet}`).join('\n')
    : 'No web search results found for this contractor.';

  const prompt = `You are evaluating a contractor bid for a renovation project. Respond with valid JSON only — no markdown, no explanation.

PROJECT DETAILS:
Type: ${listingDetails?.renovationType || 'Renovation'}
Address: ${listingDetails?.propertyAddress || 'on file'}
Owner budget: $${listingDetails?.estimatedCostRange?.low?.toLocaleString() || '?'} – $${listingDetails?.estimatedCostRange?.high?.toLocaleString() || '?'}

CONTRACTOR BID:
Company: ${bid.contractor?.companyName || 'Unknown'}
Bid Amount: $${bid.bidAmount?.toLocaleString() || '?'}
Years in Business: ${bid.contractor?.yearsInBusiness || 'Unknown'}
License: ${bid.contractor?.licenseNumber || 'Not provided'}
Specialties: ${Array.isArray(bid.contractor?.specialties) ? bid.contractor.specialties.join(', ') : 'General'}
Scope: ${bid.scope || 'Not specified'}
Estimated Duration: ${bid.estimatedDuration || 'Not specified'}
Warranty: ${bid.warranty || 'None stated'}

WEB REPUTATION RESEARCH:
${snippetsText}

Return JSON with exactly these fields:
{
  "companySearchSummary": "<2-3 sentence summary of web research findings or lack thereof>",
  "reviewSentiment": "<positive|neutral|negative>",
  "qualityScore": <integer 0-100, based on reputation signals and credentials>,
  "credibilityScore": <integer 0-100, based on license, years in business, DUNS verification if mentioned>,
  "valueScore": <integer 0-100, balance of quality relative to bid price vs budget>,
  "recommendation": "<one sentence recommendation for the property owner>",
  "sources": [{ "platform": "<platform name>", "url": "<url>", "snippet": "<10-20 word relevant quote>" }]
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    max_tokens: 700
  });

  return JSON.parse(completion.choices[0].message.content);
}

/**
 * POST /api/bid-analysis/analyze
 * Body: {
 *   bids: MarketplaceBid[],
 *   listingDetails: { renovationType, propertyAddress, estimatedCostRange }
 * }
 */
router.post('/analyze', async (req, res) => {
  try {
    const { bids, listingDetails } = req.body;
    if (!bids?.length) {
      return res.json({ success: true, analyzedBids: [] });
    }

    const analyzedBids = await Promise.all(
      bids.map(async (bid) => {
        try {
          const searchResults = await searchContractorReputation(
            bid.contractor?.companyName || 'Unknown Contractor',
            listingDetails?.renovationType || 'renovation'
          );

          const analysis = await scoreBidWithAI(bid, listingDetails, searchResults);

          return {
            ...bid,
            aiAnalysis: {
              ...analysis,
              analyzedAt: new Date().toISOString()
            }
          };
        } catch (bidErr) {
          console.error('[BidAnalysis] Error scoring bid', bid.id, ':', bidErr.message);
          // Return bid without analysis rather than failing the whole batch
          return bid;
        }
      })
    );

    // Sort by valueScore descending, assign rank
    analyzedBids.sort((a, b) => (b.aiAnalysis?.valueScore || 0) - (a.aiAnalysis?.valueScore || 0));
    analyzedBids.forEach((bid, idx) => {
      if (bid.aiAnalysis) bid.aiAnalysis.rank = idx + 1;
    });

    res.json({ success: true, analyzedBids });
  } catch (err) {
    console.error('[BidAnalysis] analyze error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
