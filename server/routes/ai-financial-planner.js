/**
 * AI Financial Planner - Backend Route
 * Uses Claude API to provide retirement planning advice,
 * asset reallocation recommendations, and hypothetical scenario analysis.
 */

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getFirestore, initializeFirebaseAdmin, requireAuth } from '../firebase-admin.js';

const router = express.Router();

initializeFirebaseAdmin();
const db = getFirestore();

const anthropic = new Anthropic({
  apiKey: process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY,
});

const MAX_DRAFT_SCENARIOS = 5;

function asFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function formatPercent(value, fallback = 0) {
  const nextValue = asFiniteNumber(value, fallback);
  return nextValue > 1 ? nextValue : nextValue * 100;
}

function normalizeScenarioDraftId(value, fallbackLabel, index) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  const slugSource = typeof fallbackLabel === 'string' && fallbackLabel.trim()
    ? fallbackLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : `draft-${index + 1}`;
  return `planner-${slugSource || `draft-${index + 1}`}`;
}

function normalizeScenarioDraft(rawDraft, index) {
  if (!rawDraft || typeof rawDraft !== 'object') {
    return null;
  }

  const name = typeof rawDraft.name === 'string' && rawDraft.name.trim()
    ? rawDraft.name.trim()
    : `Scenario ${index + 1}`;
  const notes = Array.isArray(rawDraft.notes)
    ? rawDraft.notes.filter(note => typeof note === 'string' && note.trim()).map(note => note.trim())
    : [];
  const timelineHints = Array.isArray(rawDraft.timelineHints)
    ? rawDraft.timelineHints
        .filter((hint) => hint && typeof hint === 'object')
        .map((hint) => ({
          kind: typeof hint.kind === 'string' ? hint.kind.trim() : 'scenario',
          year: Number(hint.year),
          label: typeof hint.label === 'string' ? hint.label.trim() : '',
          title: typeof hint.title === 'string' ? hint.title.trim() : '',
          description: typeof hint.description === 'string' ? hint.description.trim() : '',
        }))
        .filter((hint) => Number.isFinite(hint.year) && hint.label && hint.title && hint.description)
    : [];

  return {
    id: normalizeScenarioDraftId(rawDraft.id, name, index),
    name,
    summary: typeof rawDraft.summary === 'string' ? rawDraft.summary.trim() : '',
    notes,
    timelineHints,
    parameters: rawDraft.parameters && typeof rawDraft.parameters === 'object' ? rawDraft.parameters : {},
    fiYear: Number.isFinite(rawDraft.fiYear) ? rawDraft.fiYear : null,
    saveRecommended: Boolean(rawDraft.saveRecommended),
    updatedAt: Date.now(),
  };
}

function mergeFinancialContext(cachedSnapshot, liveContext) {
  const cachedContext = cachedSnapshot && typeof cachedSnapshot.financialContext === 'object'
    ? cachedSnapshot.financialContext
    : null;

  const mergedContext = {
    ...(cachedContext || {}),
    ...(liveContext && typeof liveContext === 'object' ? liveContext : {}),
  };

  if (!mergedContext.projectionSummary && cachedSnapshot?.projectionSummary) {
    mergedContext.projectionSummary = cachedSnapshot.projectionSummary;
  }

  if ((!Array.isArray(mergedContext.projectionPoints) || mergedContext.projectionPoints.length === 0)
    && Array.isArray(cachedSnapshot?.projectionPoints)) {
    mergedContext.projectionPoints = cachedSnapshot.projectionPoints;
  }

  if (!mergedContext.cachedAt && cachedSnapshot?.cachedAt) {
    mergedContext.cachedAt = cachedSnapshot.cachedAt;
  }

  return mergedContext;
}

function buildProjectionHighlights(projectionPoints) {
  if (!Array.isArray(projectionPoints) || projectionPoints.length === 0) {
    return '';
  }

  const checkpoints = projectionPoints.filter((point, index) => index === 0 || index === projectionPoints.length - 1 || point.yearsFromNow % 5 === 0).slice(0, 8);
  if (checkpoints.length === 0) {
    return '';
  }

  return `📉 **Projection Checkpoints:**\n${checkpoints.map(point => (
    `- CY${point.year}: Income $${Math.round(asFiniteNumber(point.investmentIncome)).toLocaleString()}/yr vs Cost $${Math.round(asFiniteNumber(point.costOfLiving)).toLocaleString()}/yr, Surplus $${Math.round(asFiniteNumber(point.surplus)).toLocaleString()}, Account $${Math.round(asFiniteNumber(point.accountValue)).toLocaleString()}`
  )).join('\n')}`;
}

function buildContextMessage(financialContext, plannerDraftScenarios) {
  if (!financialContext || typeof financialContext !== 'object') {
    return '';
  }

  const projectionSummary = financialContext.projectionSummary && typeof financialContext.projectionSummary === 'object'
    ? financialContext.projectionSummary
    : null;
  const projectionHighlights = buildProjectionHighlights(financialContext.projectionPoints);
  const draftScenarioBlock = Array.isArray(plannerDraftScenarios) && plannerDraftScenarios.length > 0
    ? `🧠 **Active Draft Scenarios:**\n${plannerDraftScenarios.map((scenario, index) => `- ${index + 1}. ${scenario.name}: ${scenario.summary || 'No summary yet'}${scenario.fiYear ? ` (FI ${scenario.fiYear})` : ''}`).join('\n')}`
    : '';

  return `
**Current Financial Snapshot (as of ${new Date().toLocaleDateString()}):**

📊 **Portfolio:**
- Stocks: $${Math.round(asFiniteNumber(financialContext.stockValue)).toLocaleString()} (${asFiniteNumber(financialContext.stockCount)} positions)
- Bonds: $${Math.round(asFiniteNumber(financialContext.bondValue)).toLocaleString()}
- Real Estate: $${Math.round(asFiniteNumber(financialContext.realEstateValue)).toLocaleString()} (${asFiniteNumber(financialContext.propertyCount)} properties)
- Cash: $${Math.round(asFiniteNumber(financialContext.cashValue)).toLocaleString()}
- **Total Portfolio: $${Math.round(asFiniteNumber(financialContext.totalValue)).toLocaleString()}**

💰 **Annual Income:**
- Dividend Income: $${Math.round(asFiniteNumber(financialContext.dividendIncome)).toLocaleString()}/yr
- Bond Income: $${Math.round(asFiniteNumber(financialContext.bondIncome)).toLocaleString()}/yr
- Rental Income: $${Math.round(asFiniteNumber(financialContext.rentalIncome)).toLocaleString()}/yr
- **Total Investment Income: $${Math.round(asFiniteNumber(financialContext.totalInvestmentIncome)).toLocaleString()}/yr**

💸 **Expenses:**
- Monthly Cost of Living: $${Math.round(asFiniteNumber(financialContext.monthlyCostOfLiving)).toLocaleString()}/mo ($${Math.round(asFiniteNumber(financialContext.monthlyCostOfLiving) * 12).toLocaleString()}/yr)
- Current Spending Reduction: ${formatPercent(financialContext.spendingReduction).toFixed(1)}%
${financialContext.expenseCategories ? `- Top Expense Categories: ${financialContext.expenseCategories.map(c => `${c.category}: $${Math.round(asFiniteNumber(c.monthlyAverage)).toLocaleString()}/mo`).join(', ')}` : ''}

📈 **Growth Assumptions:**
- Stock Growth: ${formatPercent(financialContext.stockGrowth, 0.07).toFixed(1)}%
- Dividend Growth: ${formatPercent(financialContext.dividendGrowth, 0.06).toFixed(1)}%
- Dividend Yield: ${formatPercent(financialContext.dividendYield, 0.025).toFixed(1)}%
- Bond Yield: ${formatPercent(financialContext.bondYield, 0.045).toFixed(1)}%
- Property Appreciation: ${formatPercent(financialContext.propertyAppreciation, 0.035).toFixed(1)}%
- Rent Growth: ${formatPercent(financialContext.rentGrowth, 0.03).toFixed(1)}%
- Inflation: ${formatPercent(financialContext.inflation, 0.03).toFixed(1)}%

🎯 **Retirement Settings:**
- Planned Retirement Year: ${financialContext.retirementYear || 'Not set (Keep Accumulating)'}
- Monthly Contributions: $${Math.round(asFiniteNumber(financialContext.monthlyContribution)).toLocaleString()}
- DRIP Enabled: ${financialContext.drip ? 'Yes' : 'No'}
- FI Target Year: ${financialContext.fiYear || projectionSummary?.fiYear || 'Not yet reached in projection'}
- Property Sale Planned: ${financialContext.propertySale ? `Yes, Year ${financialContext.propertySaleYear}` : 'No'}
- Property Purchase Planned: ${financialContext.propertyPurchase ? 'Yes' : 'No'}

${financialContext.properties ? `🏠 **Properties:**\n${financialContext.properties.map(p => `- ${p.name}: $${Math.round(asFiniteNumber(p.value)).toLocaleString()} value, $${Math.round(asFiniteNumber(p.monthlyRent)).toLocaleString()}/mo rent`).join('\n')}` : ''}
${projectionSummary ? `

📍 **Canonical FI Projection Summary:**
- Projection Horizon: ${projectionSummary.projectionYears || financialContext.projectionYears || 0} years
- Current Annual Cost of Living: $${Math.round(asFiniteNumber(projectionSummary.currentAnnualCostOfLiving)).toLocaleString()}
- Current Annual Investment Income: $${Math.round(asFiniteNumber(projectionSummary.currentAnnualInvestmentIncome)).toLocaleString()}
- Current Annual Surplus: $${Math.round(asFiniteNumber(projectionSummary.currentAnnualSurplus)).toLocaleString()}
- Canonical FI Year: ${projectionSummary.fiYear || 'Not reached'}
- Planned Retirement Year in Projection: ${projectionSummary.plannedRetirementYear || 'Not set'}
${projectionSummary.plannedRetirementIncome !== undefined ? `- Planned Retirement Income: $${Math.round(asFiniteNumber(projectionSummary.plannedRetirementIncome)).toLocaleString()}` : ''}
${projectionSummary.plannedRetirementCostOfLiving !== undefined ? `- Planned Retirement Cost of Living: $${Math.round(asFiniteNumber(projectionSummary.plannedRetirementCostOfLiving)).toLocaleString()}` : ''}
${projectionSummary.plannedRetirementSurplus !== undefined ? `- Planned Retirement Surplus: $${Math.round(asFiniteNumber(projectionSummary.plannedRetirementSurplus)).toLocaleString()}` : ''}` : ''}
${projectionHighlights ? `

${projectionHighlights}` : ''}
${draftScenarioBlock ? `

${draftScenarioBlock}` : ''}
`;
}

const SYSTEM_PROMPT = `You are an expert financial planner and retirement advisor integrated into the HouseYield real estate and investment management platform. You help users plan their path to financial independence by analyzing their current financial situation and advising on asset moves, retirement timing, and spending optimization.

**Your capabilities:**
1. **Retirement Planning**: Help users determine when they can retire based on current income, expenses, investments, and growth assumptions.
2. **Asset Reallocation**: Advise on selling/buying properties, reallocating proceeds into stocks, bonds, or cash, and timing these moves.
3. **Goal Planning**: Help users work in big purchases (vacation homes, cars, etc.) into their retirement plan and assess feasibility.
4. **Expense Optimization**: Analyze spending categories and suggest where to cut to accelerate FI (Financial Independence).
5. **Scenario Modeling**: Run what-if scenarios comparing different strategies.

**When responding, you MUST return a JSON block wrapped in \`\`\`json ... \`\`\` containing any parameter adjustments the user's conversation implies plus any active saveable scenario drafts. This JSON will be parsed to update charts and keep planner scenarios in sync automatically.**

The JSON block should use this schema:
\`\`\`json
{
  "actions": [
    {
      "type": "setRetirementYear",
      "year": 2048
    },
    {
      "type": "sellProperty",
      "year": 2034,
      "allocation": { "cash": 10, "stocks": 70, "bonds": 20 }
    },
    {
      "type": "buyProperty",
      "year": 2030,
      "purchasePrice": 500000,
      "downPaymentPercent": 25,
      "downPaymentSource": "stocks",
      "interestRate": 6.5,
      "mortgageTerm": 30,
      "expectedRent": 3000,
      "monthlyExpenses": 900,
      "expectedAppreciation": 3.5
    },
    {
      "type": "adjustSpending",
      "reductionPercent": 5,
      "categoryAdjustments": { "Dining": -30, "Entertainment": -20 }
    },
    {
      "type": "adjustContributions",
      "monthlyAmount": 2000
    },
    {
      "type": "adjustGrowthAssumptions",
      "stockGrowth": 7.0,
      "dividendGrowth": 6.0,
      "bondYield": 4.5
    },
    {
      "type": "setMonthlyCostOfLiving",
      "amount": 4500
    },
    {
      "type": "bigPurchase",
      "description": "Vacation Home",
      "year": 2035,
      "amount": 350000,
      "fundingSource": "stocks",
      "ongoingMonthlyCost": 1500
    },
    {
      "type": "reallocatePortfolio",
      "year": 2036,
      "targetAssetName": "VICI Properties",
      "targetTicker": "VICI",
      "targetYield": 0.055,
      "targetGrowth": 0.03,
      "sellAllAssets": true
    }
  ],
  "scenarioDrafts": [
    {
      "id": "aggressive-2042",
      "name": "Aggressive 2042 Exit",
      "summary": "Delay retirement to 2042, keep DRIP on, and raise contributions to build a larger surplus cushion.",
      "notes": [
        "Assumes current rental portfolio is held through retirement.",
        "Uses full current settings as the baseline and only changes the listed parameters."
      ],
      "parameters": {
        "retirementYear": 2042,
        "monthlyContribution": 2500,
        "drip": true,
        "portfolioReallocation": {
          "enabled": true,
          "year": 2036,
          "targetAssetName": "VICI Properties",
          "targetTicker": "VICI",
          "targetYield": 0.055,
          "targetGrowth": 0.03,
          "sellStocks": true,
          "sellBonds": true,
          "sellRealEstate": true,
          "sellCash": true
        }
      },
      "fiYear": 2038,
      "saveRecommended": true
    }
  ]
}
\`\`\`

Rules for \`scenarioDrafts\`:
- Keep 1 to 3 distinct scenarios when the conversation explores alternatives.
- Update or replace existing drafts as the conversation evolves instead of duplicating near-identical ones.
- Each draft must be specific enough that it can be saved directly by the UI.
- \`parameters\` should contain the settings that differ from the current baseline. HouseYield will merge them with the live planner state before saving.
- Use decimal values for stored growth assumptions in \`parameters\` (for example 0.07 for 7%, 0.03 for 3%, 0.25 for a 25% spending reduction only when the UI stores a fraction).
- For "sell everything into one income asset" scenarios, use \`reallocatePortfolio\` and/or \`parameters.portfolioReallocation\` instead of leaving the move only in summary text.
- If there is no useful scenario to save yet, return an empty \`scenarioDrafts\` array.

**Response style guidelines:**
- Be conversational but data-driven
- Always reference specific numbers from the user's financial data
- When recommending changes, explain the trade-offs clearly
- Show before/after comparisons when adjusting parameters
- Be encouraging but realistic — don't sugarcoat if retirement goals are unrealistic
- When a user asks about big purchases, calculate impact on FI date
- Always include the JSON block so the charts and scenario drafts update automatically
- Use dollar formatting with commas for readability
- When multiple scenarios exist, compare them clearly

Remember: The user is viewing a Financial Independence chart that shows Cost of Living (red line) vs Investment Income (green line) over 30 years, with an "FI" marker where income crosses above expenses. Your JSON actions directly modify the chart parameters.`;

// POST /api/ai-financial-planner/chat
router.post('/chat', requireAuth, async (req, res) => {
  try {
    const { messages, financialContext } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: 'messages array required' });
    }

    const userSnapshot = await db.collection('users').doc(req.user.uid).get();
    const userData = userSnapshot.exists ? userSnapshot.data() || {} : {};
    const plannerSnapshot = userData.financialPlannerSnapshot && typeof userData.financialPlannerSnapshot === 'object'
      ? userData.financialPlannerSnapshot
      : null;
    const existingDraftScenarios = Array.isArray(userData.financialPlannerDraftScenarios)
      ? userData.financialPlannerDraftScenarios
      : [];
    const mergedFinancialContext = mergeFinancialContext(plannerSnapshot, financialContext);
    const contextMessage = buildContextMessage(mergedFinancialContext, existingDraftScenarios);

    // Build messages for Claude
    const claudeMessages = messages.map(m => ({
      role: m.role,
      content: m.role === 'user' && m === messages[0] && contextMessage
        ? `${contextMessage}\n\n---\n\n${m.content}`
        : m.content,
    }));

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: claudeMessages,
    });

    const assistantMessage = response.content[0].text;

    // Extract JSON actions from the response
    let actions = [];
    let scenarioDrafts = existingDraftScenarios;
    const jsonMatch = assistantMessage.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        actions = parsed.actions || [];
        if (Array.isArray(parsed.scenarioDrafts)) {
          scenarioDrafts = parsed.scenarioDrafts
            .map((draft, index) => normalizeScenarioDraft(draft, index))
            .filter(Boolean)
            .slice(0, MAX_DRAFT_SCENARIOS);
        }
      } catch (e) {
        console.warn('[AI Financial Planner] Could not parse JSON actions:', e.message);
      }
    }

    await db.collection('users').doc(req.user.uid).set({
      financialPlannerDraftScenarios: scenarioDrafts,
      financialPlannerWorkspaceUpdatedAt: new Date().toISOString(),
    }, { merge: true });

    // Clean the message text (remove the JSON block for display)
    const displayMessage = assistantMessage.replace(/```json[\s\S]*?```/g, '').trim();

    res.json({
      ok: true,
      message: displayMessage,
      actions,
      scenarioDrafts,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error('[AI Financial Planner] Error:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to get AI response',
    });
  }
});

export default router;
