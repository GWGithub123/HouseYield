/**
 * Listing AI Description Generator
 * Uses GPT-4o to generate a professional renovation listing description
 * for property owners posting to the contractor marketplace.
 *
 * Required env vars: OPENAI_API_KEY
 */

import express from 'express';
import OpenAI from 'openai';

const router = express.Router();

let openai;
try {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} catch {
  // Will fail gracefully per-request
}

/**
 * POST /api/listing-ai/generate-description
 * Body: {
 *   suggestionData: { name, type, summary, cost, costRange, materialBreakdown,
 *                     laborBreakdown, priority, timeframe, details },
 *   propertyAddress: string,
 *   scanMetadata: { roomDimensions? }
 * }
 */
router.post('/generate-description', async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not configured' });
    }

    const { suggestionData, propertyAddress, scanMetadata } = req.body;

    // Compute cost totals from breakdowns
    const materialTotal = (suggestionData?.materialBreakdown || [])
      .reduce((sum, m) => sum + (m.totalCost || 0), 0);
    const laborTotal = (suggestionData?.laborBreakdown || [])
      .reduce((sum, l) => sum + (l.totalCost || 0), 0);

    // Dimensions string
    const dims = scanMetadata?.roomDimensions;
    const dimStr = dims
      ? `Room dimensions: ${dims.widthFeet || dims.widthFt || '?'} ft × ${dims.lengthFeet || dims.lengthFt || '?'} ft (${dims.floorAreaSqFt || '?'} sq ft, ${dims.heightFeet || dims.heightFt || '?'} ft ceiling)`
      : null;

    // Material line items (top 5)
    const topMaterials = (suggestionData?.materialBreakdown || [])
      .slice(0, 5)
      .map(m => `  - ${m.item}: $${(m.totalCost || 0).toLocaleString()}`)
      .join('\n');

    // Labor line items (top 5)
    const topLabor = (suggestionData?.laborBreakdown || [])
      .slice(0, 5)
      .map(l => `  - ${l.task}: $${(l.totalCost || 0).toLocaleString()}`)
      .join('\n');

    const prompt = `Write a professional renovation listing description for a property owner seeking contractor bids on a real estate marketplace. This description will be read by licensed contractors deciding whether to bid.

PROJECT INFORMATION:
Name: ${suggestionData?.name || suggestionData?.type || 'Renovation'}
Summary: ${suggestionData?.summary || ''}
Details: ${suggestionData?.details || ''}
Priority: ${suggestionData?.priority || 'standard'}
Timeframe: ${suggestionData?.timeframe || 'TBD'}
Property: ${propertyAddress || 'Address on file'}
${dimStr ? dimStr : ''}

ESTIMATED COSTS:
Total range: $${(suggestionData?.costRange?.low || 0).toLocaleString()} – $${(suggestionData?.costRange?.high || 0).toLocaleString()}
Materials subtotal: $${materialTotal.toLocaleString()}
Labor subtotal: $${laborTotal.toLocaleString()}

KEY MATERIALS:
${topMaterials || '  - Not specified'}

KEY LABOR TASKS:
${topLabor || '  - Not specified'}

INSTRUCTIONS:
Write 2–3 paragraphs that:
1. Open by describing the scope and goals of the project clearly for a contractor audience
2. Specify the key work areas, materials, and dimensions where provided
3. State the budget expectations and desired timeline, and invite competitive bids from qualified contractors
Keep the tone professional and informative. Do not invent specific details not present in the information above.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700
    });

    const description = completion.choices[0].message.content.trim();

    res.json({ success: true, description });
  } catch (err) {
    console.error('[ListingAI] generate-description error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
