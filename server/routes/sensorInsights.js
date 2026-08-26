/**
 * Sensor Insights — AI-powered environmental health analysis
 *
 * POST /api/sensor-insights
 * Body: {
 *   rooms: [{
 *     name: string,
 *     moldRiskIndex: number,     // 0-100
 *     moldRisk: number,          // legacy alias of moldRiskIndex
 *     materialDamageIndex: number, // 0-100
 *     ventilationScore: number,  // 0-100 (higher = better)
 *     currentTempF: number | null,
 *     currentHumidity: number | null,
 *     peakHumidity: number | null,
 *     hoursAbove60: number,
 *     hoursAbove70: number,
 *     hoursAbove80: number,
 *     humidityCycles: number,
 *     avgRecoveryMinutes: number | null,
 *     statusSummary: string,
 *     recentReadings: number,    // count of readings in last 24h
 *   }],
 *   propertyAddress: string,
 * }
 */

import express from 'express';

const router = express.Router();

const SYSTEM_PROMPT = `You are an expert home environmental health analyst working with a property management company. Analyze the sensor data from a rental property and provide specific, actionable maintenance recommendations.

Focus on:
- Preventing mold growth and moisture damage
- Maintaining healthy air quality for tenants
- Energy efficiency and insulation improvements
- Early warning of maintenance issues

Guidelines:
- Be specific: suggest products, durations, timing, and thresholds when relevant
- Keep each recommendation concise (2-3 sentences)
- Prioritize by risk to tenant health and property damage
- Consider the interplay between humidity, temperature, and ventilation
- Scores: moldRiskIndex 0-100 (higher=worse, exposure-based), materialDamageIndex 0-100 (higher=worse moisture stress on finishes/materials), ventilationScore 0-100 (higher=better)
- Use the exposure metrics (hours above 60/70/80, humidityCycles, avgRecoveryMinutes, peakHumidity) to explain why a room is risky or healthy
- Do not confuse moldRiskIndex with a literal lab-confirmed mold measurement; it is a moisture exposure risk index

Return ONLY valid JSON in this exact format:
{
  "recommendations": [
    {
      "room": "room name",
      "issue": "brief issue description",
      "recommendation": "specific actionable recommendation",
      "priority": "low|medium|high|urgent",
      "estimatedCost": "$XX-$XXX or Free"
    }
  ],
  "overallScore": 0-100,
  "summary": "2-3 sentence overall summary of property environmental health"
}`;

router.post('/', async (req, res) => {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY not configured' });
    }

    const { rooms = [], propertyAddress = 'Property' } = req.body || {};

    if (!Array.isArray(rooms) || rooms.length === 0) {
      return res.status(400).json({ ok: false, error: 'rooms array is required and must not be empty' });
    }

    // Build the analysis prompt
    const roomSummaries = rooms.map(room => {
      const lines = [
        `Room: ${room.name || 'Unknown'}`,
        room.currentTempF != null ? `  Temperature: ${room.currentTempF.toFixed(1)}°F` : null,
        room.currentHumidity != null ? `  Humidity: ${room.currentHumidity.toFixed(1)}%` : null,
        `  Mold Risk Index: ${room.moldRiskIndex ?? room.moldRisk}/100 (${(room.moldRiskIndex ?? room.moldRisk) >= 70 ? 'HIGH' : (room.moldRiskIndex ?? room.moldRisk) >= 40 ? 'MODERATE' : 'LOW'})`,
        `  Material Damage Index: ${room.materialDamageIndex ?? 0}/100 (${(room.materialDamageIndex ?? 0) >= 70 ? 'HIGH' : (room.materialDamageIndex ?? 0) >= 40 ? 'MODERATE' : 'LOW'})`,
        `  Ventilation Score: ${room.ventilationScore}/100 (${room.ventilationScore >= 70 ? 'GOOD' : room.ventilationScore >= 40 ? 'FAIR' : 'POOR'})`,
        room.peakHumidity != null ? `  Peak Humidity: ${room.peakHumidity}%` : null,
        room.hoursAbove60 != null ? `  Time Above 60% RH: ${room.hoursAbove60}h` : null,
        room.hoursAbove70 != null ? `  Time Above 70% RH: ${room.hoursAbove70}h` : null,
        room.hoursAbove80 != null ? `  Time Above 80% RH: ${room.hoursAbove80}h` : null,
        room.humidityCycles != null ? `  Humidity Cycles: ${room.humidityCycles}` : null,
        room.avgRecoveryMinutes != null ? `  Avg Recovery Time: ${room.avgRecoveryMinutes} minutes` : null,
        room.statusSummary ? `  Status: ${room.statusSummary}` : null,
        room.recentReadings != null ? `  Data Points (24h): ${room.recentReadings}` : null,
      ].filter(Boolean);
      return lines.join('\n');
    }).join('\n\n');

    const userPrompt = `Analyze the environmental sensor data for: ${propertyAddress}

${roomSummaries}

Provide specific, actionable recommendations for maintaining a healthy rental property environment.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SensorInsights] OpenAI error:', response.status, errorText.slice(0, 300));
      return res.status(502).json({ ok: false, error: `OpenAI API error: ${response.status}` });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response (handle markdown code blocks)
    let parsed;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      try {
        parsed = JSON.parse(content.trim());
      } catch {
        console.error('[SensorInsights] Failed to parse OpenAI response:', content.slice(0, 500));
        return res.status(502).json({ ok: false, error: 'Failed to parse AI response', rawContent: content.slice(0, 500) });
      }
    }

    return res.json({
      ok: true,
      recommendations: parsed.recommendations || [],
      overallScore: parsed.overallScore ?? null,
      summary: parsed.summary || '',
      analyzedAt: new Date().toISOString(),
      roomCount: rooms.length,
    });

  } catch (err) {
    console.error('[SensorInsights] Unexpected error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
