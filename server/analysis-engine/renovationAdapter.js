/**
 * renovationAdapter.js — stable interface between the deal engine and the
 * (evolving) AI renovation analysis system.
 *
 * Contract:
 *   analyzeRenovationOpportunities({ photos, subject, valuation, zipMarket })
 *     -> {
 *          conditionGrade, conditionScore, conditionNotes,
 *          projects: [{ name, area, cost, valueUplift, rentUpliftMonthly, roiPct, description }],
 *          totals: { cost, valueUplift, rentUpliftMonthly },
 *          arv, monthlyRentAfter,
 *          source
 *        }
 *
 * v1 implementation: one GPT-4o vision call over the uploaded photos.
 * The in-progress renovation system on the Renovations page can replace the
 * internals later without touching the engine.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buildPrompt(subject, valuation) {
  const facts = [
    subject.beds != null ? `${subject.beds} bed` : null,
    subject.baths != null ? `${subject.baths} bath` : null,
    subject.sqft != null ? `${subject.sqft} sqft` : null,
    subject.yearBuilt != null ? `built ${subject.yearBuilt}` : null,
    subject.propertyType || null,
  ].filter(Boolean).join(', ');
  const fairValue = num(valuation?.fairValue);

  return `You are a renovation underwriter for a BRRRR real-estate investor. Analyze these property photos (${facts || 'details unknown'}${fairValue ? `, estimated current value $${fairValue.toLocaleString()}` : ''}).

Respond with STRICT JSON only (no markdown fences):
{
  "conditionGrade": "A|B|C|D|F",
  "conditionScore": 0-100,
  "conditionNotes": "2 sentence overall condition summary",
  "projects": [
    {
      "name": "short project name",
      "area": "kitchen|bathroom|flooring|paint|exterior|landscaping|systems|other",
      "cost": estimated total cost in USD (realistic contractor pricing),
      "valueUplift": estimated resale value increase in USD,
      "rentUpliftMonthly": estimated monthly rent increase in USD,
      "description": "1 sentence what and why"
    }
  ]
}

Rules:
- Only include projects visible/inferable from the photos with positive expected ROI for a rental investor.
- Be conservative on uplifts. Cosmetic refreshes before structural gut jobs.
- 0-6 projects. Empty array if the property is already renovated.`;
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

const GRADE_SCORES = { A: 92, B: 80, C: 65, D: 45, F: 25 };

/**
 * Analyze photos for renovation opportunities + condition.
 * Returns null when no photos are provided (regional/no-photo flows should
 * fall back to market-level uplift assumptions instead).
 */
export async function analyzeRenovationOpportunities({ photos, subject = {}, valuation = null }) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  if (!OPENAI_API_KEY) {
    console.warn('[RenovationAdapter] OPENAI_API_KEY missing — skipping photo analysis');
    return null;
  }

  // Cap photos to control token cost; sample evenly across the set
  const maxPhotos = 16;
  const sampled = photos.length <= maxPhotos
    ? photos
    : Array.from({ length: maxPhotos }, (_, i) => photos[Math.floor((i * photos.length) / maxPhotos)]);

  const imageContent = sampled.map((photo) => {
    const url = typeof photo === 'string'
      ? (photo.startsWith('data:') || photo.startsWith('http') ? photo : `data:image/jpeg;base64,${photo}`)
      : photo?.url;
    return { type: 'image_url', image_url: { url, detail: 'low' } };
  }).filter((c) => c.image_url.url);

  if (!imageContent.length) return null;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1600,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(subject, valuation) },
          ...imageContent,
        ],
      }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`renovation_vision_failed:${response.status}:${text.slice(0, 120)}`);
  }

  const payload = await response.json();
  const parsed = extractJson(payload.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('renovation_vision_unparseable');

  const grade = ['A', 'B', 'C', 'D', 'F'].includes(parsed.conditionGrade) ? parsed.conditionGrade : 'C';
  const projects = (Array.isArray(parsed.projects) ? parsed.projects : [])
    .map((p) => {
      const cost = num(p.cost);
      const valueUplift = num(p.valueUplift) ?? 0;
      const rentUplift = num(p.rentUpliftMonthly) ?? 0;
      if (!cost || cost <= 0) return null;
      return {
        name: String(p.name || 'Renovation project').slice(0, 80),
        area: String(p.area || 'other'),
        cost: round(cost),
        valueUplift: round(valueUplift),
        rentUpliftMonthly: round(rentUplift),
        roiPct: cost > 0 ? round(((valueUplift - cost) / cost) * 100, 1) : null,
        description: String(p.description || '').slice(0, 240),
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  const totals = projects.reduce((acc, p) => ({
    cost: acc.cost + (p.cost || 0),
    valueUplift: acc.valueUplift + (p.valueUplift || 0),
    rentUpliftMonthly: acc.rentUpliftMonthly + (p.rentUpliftMonthly || 0),
  }), { cost: 0, valueUplift: 0, rentUpliftMonthly: 0 });

  const fairValue = num(valuation?.fairValue);

  return {
    conditionGrade: grade,
    conditionScore: num(parsed.conditionScore) ?? GRADE_SCORES[grade],
    conditionNotes: String(parsed.conditionNotes || '').slice(0, 500),
    projects,
    totals: {
      cost: round(totals.cost),
      valueUplift: round(totals.valueUplift),
      rentUpliftMonthly: round(totals.rentUpliftMonthly),
    },
    arv: fairValue != null ? round(fairValue + totals.valueUplift) : null,
    photosAnalyzed: imageContent.length,
    source: 'gpt-4o-vision-v1',
  };
}

/**
 * Market-level renovation assumption for no-photo (screener) flows:
 * a modest cosmetic-refresh model scaled by property age.
 */
export function estimateMarketLevelRenovation(subject, valuation) {
  const fairValue = num(valuation?.fairValue);
  if (!fairValue) return null;

  const age = num(subject.age) ?? (num(subject.yearBuilt) ? new Date().getFullYear() - num(subject.yearBuilt) : null);
  if (age == null || age < 15) return null;

  const intensity = age > 50 ? 0.08 : age > 30 ? 0.055 : 0.035;
  const cost = round(fairValue * intensity / 1000) * 1000;
  const valueUplift = round(cost * 1.5 / 1000) * 1000;
  const rentUpliftMonthly = round(cost * 0.004 / 5) * 5;

  return {
    conditionGrade: null,
    conditionScore: null,
    conditionNotes: `No photos provided — modeled a typical cosmetic refresh for a ${age}-year-old property. Upload photos for a property-specific renovation plan.`,
    projects: [{
      name: 'Cosmetic refresh (modeled)',
      area: 'other',
      cost,
      valueUplift,
      rentUpliftMonthly,
      roiPct: cost > 0 ? round(((valueUplift - cost) / cost) * 100, 1) : null,
      description: 'Age-based estimate of paint, flooring, fixtures and kitchen/bath refresh potential.',
    }],
    totals: { cost, valueUplift, rentUpliftMonthly },
    arv: round(fairValue + valueUplift),
    photosAnalyzed: 0,
    source: 'market-level-estimate',
  };
}
