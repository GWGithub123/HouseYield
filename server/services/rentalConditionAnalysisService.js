function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseJson(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  return JSON.parse((fenced?.[1] || text).trim());
}

function normalizeAnalysis(raw, photoCount) {
  const parsedScore = Number(raw.conditionScore);
  const parsedConfidence = Number(raw.confidence);
  const parsedCoverage = Number(raw.coverageScore);
  const conditionScore = clamp(Number.isFinite(parsedScore) ? parsedScore : 50, 0, 100);
  const confidence = clamp(Number.isFinite(parsedConfidence) ? parsedConfidence : 0.5, 0, 1);
  const coverageScore = clamp(Number.isFinite(parsedCoverage) ? parsedCoverage : 0.4, 0, 1);
  // The comp set already captures average market condition. Only apply a
  // bounded, confidence/coverage-weighted adjustment around a market-ready
  // score of 65 to avoid double counting appearance.
  const rawAdjustment = (conditionScore - 65) * 0.12;
  const rentAdjustmentPct = Math.round(
    clamp(rawAdjustment * confidence * coverageScore, -5, 4) * 10,
  ) / 10;

  return {
    conditionScore: Math.round(conditionScore),
    conditionClass: ['poor', 'fair', 'average', 'good', 'excellent'].includes(raw.conditionClass)
      ? raw.conditionClass
      : conditionScore >= 85 ? 'excellent'
        : conditionScore >= 72 ? 'good'
          : conditionScore >= 58 ? 'average'
            : conditionScore >= 42 ? 'fair'
              : 'poor',
    confidence: Math.round(confidence * 100) / 100,
    coverageScore: Math.round(coverageScore * 100) / 100,
    photoCount,
    roomsObserved: Array.isArray(raw.roomsObserved) ? raw.roomsObserved.slice(0, 20) : [],
    strengths: Array.isArray(raw.strengths) ? raw.strengths.slice(0, 12) : [],
    deficiencies: Array.isArray(raw.deficiencies) ? raw.deficiencies.slice(0, 12) : [],
    roomAnalyses: Array.isArray(raw.roomAnalyses) ? raw.roomAnalyses.slice(0, photoCount) : [],
    marketabilitySummary: String(raw.marketabilitySummary || '').slice(0, 1200),
    missingCoverage: Array.isArray(raw.missingCoverage) ? raw.missingCoverage.slice(0, 12) : [],
    rentAdjustmentPct,
    adjustmentMethod: 'Bounded ±5% adjustment around market-ready score 65, weighted by AI confidence and photo coverage.',
    model: raw.model || null,
  };
}

export async function analyzeRentalCondition({
  images,
  property = {},
  apiKey,
  model = 'gpt-4o-mini',
}) {
  if (!apiKey) throw new Error('openai_not_configured');
  const validImages = (images || [])
    .filter((image) => typeof image === 'string' && image.startsWith('data:image/'))
    .slice(0, 12);
  if (!validImages.length) throw new Error('images_required');

  const prompt = `You are a conservative residential rental-condition analyst.
Assess only visible condition and marketability from the supplied property photos.
Do not infer hidden defects, neighborhood quality, rent, protected-class suitability, or exact renovation costs.
Judge relative to a typical market-ready long-term rental, where 65/100 is ordinary clean market-ready condition.

Property context:
${JSON.stringify({
    address: property.address || null,
    propertyType: property.propertyType || null,
    bedrooms: property.bedrooms || null,
    bathrooms: property.bathrooms || null,
    squareFeet: property.squareFeet || null,
    yearBuilt: property.yearBuilt || null,
  })}

Return JSON only:
{
  "conditionScore": 0-100,
  "conditionClass": "poor|fair|average|good|excellent",
  "confidence": 0-1,
  "coverageScore": 0-1,
  "roomsObserved": ["..."],
  "strengths": ["visible, rental-relevant strength"],
  "deficiencies": ["visible, rental-relevant weakness"],
  "missingCoverage": ["important area not shown"],
  "marketabilitySummary": "concise explanation",
  "roomAnalyses": [
    {
      "photoIndex": 0,
      "roomType": "exterior|kitchen|bathroom|bedroom|living_room|dining_room|basement|garage|other",
      "conditionScore": 0-100,
      "visibleNotes": ["..."],
      "marketabilityImpact": "negative|neutral|positive"
    }
  ]
}`;

  const content = [
    { type: 'text', text: prompt },
    ...validImages.map((url) => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
  ];
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`openai_vision_${response.status}: ${detail.slice(0, 250)}`);
  }

  const payload = await response.json();
  const parsed = parseJson(payload.choices?.[0]?.message?.content);
  return normalizeAnalysis({ ...parsed, model }, validImages.length);
}

export { normalizeAnalysis as normalizeRentalConditionAnalysis };

