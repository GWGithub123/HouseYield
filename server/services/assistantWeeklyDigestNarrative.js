/**
 * Weekly Digest AI Narrative
 *
 * Turns the assembled weekly digest data into a personalized, newsletter-style
 * narrative using the platform's canonical OpenAI integration. The narrative is
 * strictly additive: if the model is unavailable or returns malformed output,
 * the digest falls back to the structured template untouched.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const NARRATIVE_MODEL = process.env.ASSISTANT_WEEKLY_DIGEST_MODEL || 'gpt-4o-mini';
const NARRATIVE_MAX_TOKENS = 1400;
const NARRATIVE_TIMEOUT_MS = 60_000;

function clipText(value, maxLength = 200) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

const PERSONAL_FINANCE_PROSE_PATTERN = /\b(net worth|stock portfolio|stock holdings?|equities|asml|portfolio allocation|dividend|ticker|brokerage|etf|mutual fund|securities|stock market)\b/i;

function isPersonalFinanceProse(text) {
  return PERSONAL_FINANCE_PROSE_PATTERN.test(String(text || ''));
}

function filterPersonalFinanceProse(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || isPersonalFinanceProse(normalized)) {
    return '';
  }
  return normalized;
}

function normalizeStringList(value, { limit = 6, maxLength = 220 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clipText(typeof item === 'string' ? item : item?.text || item?.summary || '', maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function filterPersonalFinanceList(items, options = {}) {
  return normalizeStringList(items, options).filter((item) => !isPersonalFinanceProse(item));
}

/**
 * Build a compact, model-friendly view of the digest. We deliberately strip
 * markup, cache metadata, and any field the model does not need so the prompt
 * stays small and the model focuses on signal.
 */
export function buildNarrativeModelInput(digest) {
  const macro = digest.macro || {};
  return {
    weekLabel: digest.window?.label || null,
    recipient: {
      name: digest.recipient?.displayName || null,
    },
    memory: {
      preferences: normalizeStringList(digest.memory?.userPreferences),
      searchHistory: normalizeStringList(digest.memory?.searchMemory),
      recentSessions: normalizeStringList(
        (digest.memory?.recentSessions || []).map((session) => session?.summary || ''),
      ),
    },
    financialWeek: digest.financialWeek?.available
      ? {
        rentCollected: digest.financialWeek.rentCollected,
        expectedMonthlyRent: digest.financialWeek.expectedMonthlyRent,
        otherIncome: digest.financialWeek.otherIncome,
        totalExpenses: digest.financialWeek.totalExpenses,
        topExpenseCategories: digest.financialWeek.topExpenseCategories,
        netCashFlow: digest.financialWeek.netCashFlow,
      }
      : null,
    propertyValue: digest.propertyValue?.available
      ? {
        propertyValue: digest.propertyValue.propertyValue,
        weekChange: digest.propertyValue.weekChange,
        weekChangePercent: digest.propertyValue.weekChangePercent,
      }
      : null,
    leases: digest.leases?.ok
      ? {
        tenantCount: digest.leases.tenantCount,
        expectedMonthlyRent: digest.leases.expectedMonthlyRent,
        expiringLeases: digest.leases.expiringLeases,
        newLeases: digest.leases.newLeases,
      }
      : null,
    properties: (digest.properties || []).map((property) => ({
      address: property.address,
      monthlyRent: property.monthlyRent,
      propertyValue: property.propertyValue,
      occupancyStatus: property.occupancyStatus,
    })),
    managementActivity: digest.managementActivity?.ok
      ? {
        newMaintenanceRequests: (digest.managementActivity.newMaintenanceRequests || []).map((request) => ({
          title: request.title,
          status: request.status,
          tenantName: request.tenantName,
        })),
        openMaintenanceCount: digest.managementActivity.openMaintenanceCount,
        unreadMessageCount: digest.managementActivity.unreadMessageCount,
        newMessages: (digest.managementActivity.newMessages || []).map((message) => message.preview),
        collectedThisWeek: digest.managementActivity.collectedThisWeek,
        paymentCount: (digest.managementActivity.paymentsThisWeek || []).length,
      }
      : null,
    pricingPower: digest.pricingPower?.properties?.length
      ? digest.pricingPower.properties.map((entry) => ({
        address: entry.address,
        zipCode: entry.zipCode,
        currentRent: entry.currentRent,
        marketMedianRent: entry.marketMedianRent,
        pricingPowerDollar: entry.pricingPowerDollar,
        pricingPowerPercent: entry.pricingPowerPercent,
        position: entry.position,
      }))
      : [],
    regionalMarkets: (digest.regional?.zipRegions || []).map((region) => ({
      zipCode: region.zipCode,
      medianAskingRent: region.rentcast?.derived?.medianAskingRent ?? null,
      grossYieldPct: region.rentcast?.derived?.grossYieldPct ?? null,
      appreciationPercent: region.attom?.appreciation?.appreciationPercent ?? null,
    })),
    metroMarkets: (digest.regional?.metroRegions || []).map((metro) => ({
      name: metro.name,
      avgMedianAskingRent: metro?.data?.summary?.avgMedianAskingRent ?? null,
      avgMedianSalePrice: metro?.data?.summary?.avgMedianSalePrice ?? null,
    })),
    listingsWatch: digest.listingsWatch?.regions?.length
      ? digest.listingsWatch.regions.map((region) => ({
        zipCode: region.zipCode,
        newListingCount: region.newListingCount,
        sampleListings: (region.listings || []).map((listing) => ({
          address: listing.address,
          price: listing.price,
          bedrooms: listing.bedrooms,
          bathrooms: listing.bathrooms,
        })),
      }))
      : [],
    macro: macro.available
      ? {
        fedFundsRate: macro.fedFundsRate,
        inflationRate: macro.inflationRate,
        unemploymentRate: macro.unemploymentRate,
        mortgageRate: macro.mortgageRate,
        keyTreasuryRate: macro.keyTreasuryRate,
        yieldCurve: macro.yieldCurve,
        rateEnvironment: macro.rateEnvironment,
        medianHomePrice: macro.medianHomePrice,
        headlines: (macro.headlines || []).map((headline) => headline.title),
      }
      : null,
    tax: digest.tax?.ok
      ? {
        upcomingDeadlines: (digest.tax.upcomingDeadlines || []).map((deadline) => ({
          name: deadline.name,
          date: deadline.date,
          daysUntil: deadline.daysUntil,
        })),
        newDocuments: (digest.tax.newDocuments || []).map((document) => document.name),
        journalEntriesThisWeek: digest.tax.journalEntriesThisWeek,
        estimatedPaymentsRecorded: digest.tax.estimatedPaymentsRecorded,
      }
      : null,
    webBriefs: (digest.regional?.webBriefs || []).map((brief) => ({
      query: brief.query,
      topResults: (brief.results || []).slice(0, 2).map((result) => result.title),
    })),
  };
}

const NARRATIVE_SYSTEM_PROMPT = `You are HouseYield's weekly report writer. Every Sunday you turn a JSON snapshot of a landlord's week into a warm, sharp, personalized email — a rental-property operations briefing plus a short local-market note.

EXCLUDE PERSONAL FINANCE (mandatory):
- This is a real-estate landlord account only. NEVER mention net worth, stock portfolios, equities, tickers, dividends, brokerage accounts, ETFs, or any investment holdings outside rental property.
- Only discuss: rent collected, expenses, net cash flow, property values, leases, tenants, maintenance, local market rates, and macro housing signals (mortgage rates, home prices).

Voice and rules:
- Write like a trusted property analyst who knows this landlord's portfolio and goals, not a generic newsletter.
- Use the user's memory (preferences, search history, recent sessions) to tailor emphasis — e.g. if they have been researching a market, connect this week's data to that interest.
- Be concrete and show the "why" behind every number: never state a metric without the components that explain it (e.g. "net cash flow was -$430 because a $1,200 HVAC repair posted against $2,400 in rent"). Never invent numbers, properties, listings, or news that are not in the data.
- Never tell the reader to "check the dashboard" or "review the card" for a value that appears in the data — state the value and its derivation directly.
- If a section has no data, omit commentary for it rather than padding.
- Keep the executive summary to 2-4 sentences that capture the single most important thing in each major area (money this week, tenants, maintenance, market).
- Action items must be specific and achievable this week (e.g. "Review the pending maintenance request from Jane before Tuesday", "Renew or re-list the lease at 11822 Prestwick that expires in 24 days").
- Plain text only — no markdown, no emojis, no HTML.

Respond with strict JSON matching:
{
  "subject": string,                      // compelling email subject, <= 90 chars, mentions the week's headline insight
  "executiveSummary": string,             // 2-4 sentence overview of the week
  "sectionInsights": {                    // 1-2 sentence commentary per section; omit keys with no data
    "financialWeek": string,
    "propertyValue": string,
    "leases": string,
    "properties": string,
    "managementActivity": string,
    "pricingPower": string,
    "regionalMarkets": string,
    "listingsWatch": string,
    "macro": string,
    "tax": string
  },
  "personalNote": string,                 // 1-2 sentences tying the week to the user's remembered interests/goals; "" if no memory
  "actionItems": string[]                 // 0-5 specific action items for the coming week
}`;

function sanitizeNarrative(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const sectionInsightsRaw = parsed.sectionInsights && typeof parsed.sectionInsights === 'object'
    ? parsed.sectionInsights
    : {};
  const sectionInsights = {};
  for (const [key, value] of Object.entries(sectionInsightsRaw)) {
    const text = filterPersonalFinanceProse(clipText(value, 500));
    if (text) {
      sectionInsights[key] = text;
    }
  }

  const executiveSummary = filterPersonalFinanceProse(clipText(parsed.executiveSummary, 1200));
  if (!executiveSummary) return null;

  return {
    subject: clipText(parsed.subject, 120) || null,
    executiveSummary,
    sectionInsights,
    personalNote: filterPersonalFinanceProse(clipText(parsed.personalNote, 500)) || null,
    actionItems: filterPersonalFinanceList(parsed.actionItems, { limit: 5, maxLength: 240 }),
    model: NARRATIVE_MODEL,
    generatedAt: new Date().toISOString(),
  };
}

export async function generateWeeklyDigestNarrative(digest) {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'openai_not_configured', narrative: null };
  }

  const modelInput = buildNarrativeModelInput(digest);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NARRATIVE_TIMEOUT_MS);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: NARRATIVE_MODEL,
        temperature: 0.5,
        max_tokens: NARRATIVE_MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: NARRATIVE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Here is this week's data snapshot for ${modelInput.recipient.name || 'the user'} (${modelInput.weekLabel || 'this week'}):\n\n${JSON.stringify(modelInput)}`,
          },
        ],
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      return {
        ok: false,
        error: `openai_request_failed_${response.status}`,
        detail: clipText(errorBody, 300),
        narrative: null,
      };
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, error: 'openai_invalid_json', narrative: null };
    }

    const narrative = sanitizeNarrative(parsed);
    if (!narrative) {
      return { ok: false, error: 'openai_empty_narrative', narrative: null };
    }

    return {
      ok: true,
      narrative,
      usage: payload?.usage || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.name === 'AbortError' ? 'openai_timeout' : (error.message || 'openai_narrative_failed'),
      narrative: null,
    };
  }
}
