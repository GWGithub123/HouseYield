/**
 * Sensor Insights Assistant — AI overview + follow-up Q&A for the
 * Predictive Maintenance Analytics tab.
 *
 * Mirrors the finance-audit assistant pattern (server/finance-audit-assistant.js):
 * the frontend sends a context snapshot of what the user is looking at
 * (per-room environment stats, mold/freeze/insulation assessments, weather),
 * and Gemini answers grounded in that snapshot only.
 *
 * Endpoints (mounted at /api/sensor-insights in server/index.js):
 *   POST /api/sensor-insights/ask
 *     Body: {
 *       mode: 'overview' | 'qa',
 *       question?: string,              // required for mode 'qa'
 *       context?: object,               // analytics snapshot from the page
 *       history?: [{ role: 'user'|'assistant', text: string }]
 *     }
 *     Response: { ok, answer, bullets, confidence }
 */

import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = express.Router();

const GEMINI_API_KEY = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.SENSOR_INSIGHTS_GEMINI_MODEL || 'gemini-2.5-flash';

let gemini = null;
try {
  if (GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    gemini = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    console.log(`[SensorInsights] ✅ Gemini initialized (${GEMINI_MODEL})`);
  } else {
    console.warn('[SensorInsights] ⚠️ GEMINI_API_KEY not set — /ask will return a configuration error');
  }
} catch (error) {
  console.warn('[SensorInsights] ⚠️ Gemini initialization failed:', error.message);
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeAssistantPayload(text) {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === 'object') {
    // Occasionally the model nests the real JSON inside the "answer" string.
    if (typeof parsed.answer === 'string') {
      const nested = extractJson(parsed.answer);
      if (nested && typeof nested === 'object') {
        return {
          ...parsed,
          ...nested,
          bullets: Array.isArray(nested.bullets) ? nested.bullets : parsed.bullets,
        };
      }
    }
    return parsed;
  }
  return null;
}

function buildBasePrompt(context) {
  const contextText = context && Object.keys(context).length > 0
    ? JSON.stringify(context, null, 2)
    : '(no snapshot provided)';

  return `You are a home-environment analyst for a residential rental property platform. The user is a landlord looking at their Predictive Maintenance analytics page, which tracks per-room temperature and humidity sensors and derives mold, pipe-freeze, and insulation risk.

GROUND EVERY ANSWER IN THE SNAPSHOT BELOW — never invent readings, rooms, or risks that are not present in it. If data is missing, say so plainly.

Thresholds the platform uses:
- Mold: humidity at/above 60% RH is the mold-growth zone (EPA guidance); sustained time in zone is the main driver.
- Freeze: pipes can freeze at 32°F; warning threshold 38°F.
- Insulation: each room's 24h average temperature is compared to the house median; large drift suggests drafts, closed vents, or missing insulation.
- Local weather: if current outside weather or forecast is present in the snapshot, tie it into the reasoning. Warm outdoor temperatures reduce freeze urgency; cool/damp weather can slow dry-out and humidity recovery.

=== ANALYTICS SNAPSHOT ===
${contextText}
=== END SNAPSHOT ===`;
}

function buildOverviewPrompt(context) {
  return `${buildBasePrompt(context)}

Write a useful landlord-facing overview of this home's environmental health.

Rules:
- Plain English, no jargon. Assume the reader is not technical.
- Lead with the single most important thing overall.
- Cover ALL THREE risk areas if they exist in the snapshot: mold, freeze, and insulation.
- If local weather is available in the snapshot, explicitly mention whether it makes the current risk picture better or worse.
- Mention specific rooms and numbers from the snapshot.
- Use the bullets to separate the three risk areas, not generic commentary.
- Add a fourth bullet for weather only when it meaningfully changes the interpretation.
- If a risk area is low, say that plainly and give a reassurance instead of an action.
- Keep it concise but complete.
- No disclaimers, no preamble.

Respond with ONLY a JSON object (no markdown fences):
{
  "answer": "1-2 sentence overall read of the home right now",
  "bullets": [
    "Mold: <status + room + number + action/reassurance>",
    "Freeze: <status + room + number + action/reassurance>",
    "Insulation: <status + room + number/grade + action/reassurance>",
    "Weather: <only if relevant; explain how outside conditions affect the risks>"
  ],
  "confidence": "high"|"medium"|"low"
}`;
}

function buildQaPrompt(context, question, history) {
  const historyText = Array.isArray(history) && history.length > 0
    ? history
      .slice(-8)
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${String(turn.text || '').slice(0, 1200)}`)
      .join('\n')
    : '(none)';

  return `${buildBasePrompt(context)}

=== CONVERSATION SO FAR ===
${historyText}

The user's follow-up question: "${question}"

Rules:
- Answer only from the snapshot and standard building-science reasoning about temperature/humidity.
- Plain English, specific rooms and numbers where relevant.
- If the question cannot be answered from the snapshot, say what data would be needed.
- Keep it tight: a short answer plus at most 3 bullets.

Respond with ONLY a JSON object (no markdown fences):
{ "answer": "direct answer", "bullets": ["optional supporting bullet"], "confidence": "high"|"medium"|"low" }`;
}

router.post('/ask', async (req, res) => {
  try {
    const { mode = 'qa', question = '', context = {}, history = [] } = req.body || {};

    if (!gemini) {
      return res.status(503).json({
        ok: false,
        error: 'AI assistant is not configured on this server (missing Gemini API key).',
        code: 'gemini_not_configured',
      });
    }

    if (mode !== 'overview' && (!question || typeof question !== 'string' || !question.trim())) {
      return res.status(400).json({ ok: false, error: "Missing 'question'." });
    }

    const prompt = mode === 'overview'
      ? buildOverviewPrompt(context)
      : buildQaPrompt(context, question.trim().slice(0, 2000), history);

    const result = await gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    });
    const text = (await result.response).text();
    const parsed = normalizeAssistantPayload(text);

    const answer = String(parsed?.answer || text || '').trim();
    if (!answer) {
      return res.status(502).json({ ok: false, error: 'Empty AI response.', code: 'empty_ai_response' });
    }

    return res.json({
      ok: true,
      answer,
      bullets: Array.isArray(parsed?.bullets) ? parsed.bullets.filter(Boolean).slice(0, 4) : [],
      confidence: ['high', 'medium', 'low'].includes(parsed?.confidence) ? parsed.confidence : 'medium',
    });
  } catch (error) {
    console.error('[SensorInsights] /ask error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'sensor_insights_failed' });
  }
});

export default router;
