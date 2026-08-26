/**
 * Platform-wide assistant capability router.
 * Infers what the owner wants (analysis surface OR management workflow)
 * so the agent can navigate + execute + render the task pad for any request.
 */

export const PROPERTY_ANALYSIS_MODES = [
  'auto',
  'overview',
  'analytics',
  'refinance',
  'rental_pricing',
  'environmental_risk',
  'full',
];

export const PLATFORM_WORKSPACES = {
  documents: {
    route: '/property-management?tab=documents',
    label: 'Documents',
    keywords: ['document', 'lease', 'addendum', 'esign', 'e-sign', 'signature', 'pdf'],
  },
  tenants: {
    route: '/property-management?tab=tenants',
    label: 'Tenants',
    keywords: ['tenant', 'rent rate', 'late payment', 'message tenant', 'applicant'],
  },
  maintenance: {
    route: '/property-management?tab=maintenance',
    label: 'Maintenance',
    keywords: ['repair request', 'work order', 'plumber', 'hvac repair', 'maintenance request', 'maintenance ticket'],
  },
  bookkeeping: {
    route: '/bookkeeping',
    label: 'Bookkeeping',
    keywords: ['bookkeeping', 'expense', 'ledger', 'transaction', 'mortgage interest', 'management fee'],
  },
  tax: {
    route: '/property-management?tab=tax',
    label: 'Tax Center',
    keywords: ['tax', 'schedule e', 'irs', 'form 4562'],
  },
  sensors: {
    route: '/sensors',
    label: 'Predictive Maintenance',
    keywords: ['predictive maintenance', 'sensor dashboard', 'sensor', 'flood sensor', 'iot', 'leak', 'home protection', 'smart home'],
  },
  sensors_analytics: {
    route: '/sensors?tab=analytics',
    label: 'Predictive Maintenance Analytics',
    keywords: [
      'sensor analytics',
      'predictive maintenance analytics',
      'analytics tab',
      'mold risk',
      'mold zone',
      'freeze risk',
      'insulation grade',
      'humidity chart',
      'temperature chart',
      'environmental analytics',
    ],
  },
  sensors_alerts: {
    route: '/sensors?tab=alerts',
    label: 'Predictive Maintenance Alerts',
    keywords: ['sensor alerts', 'leak alert', 'flood alert', 'predictive maintenance alerts'],
  },
  sensors_overview: {
    route: '/sensors?tab=overview',
    label: 'Predictive Maintenance Overview',
    keywords: ['sensor overview', 'device map', 'property twin', 'predictive maintenance overview'],
  },
  market: {
    route: '/market-data',
    label: 'Market Data',
    keywords: ['market data', 'mortgage rate', 'fed', 'treasury'],
  },
  renovations: {
    route: '/renovations',
    label: 'Renovations',
    keywords: ['renovation', 'rehab', 'capex', 'remodel'],
  },
  portfolio_overview: {
    route: '/portfolio?tab=properties',
    label: 'Portfolio Overview',
    keywords: ['portfolio overview', 'portfolio summary'],
  },
  portfolio_properties: {
    route: '/portfolio?tab=properties',
    label: 'Properties',
    keywords: ['properties page', 'my properties'],
  },
};

function haystackFrom(params = {}) {
  return [
    params.requestSummary,
    params.topic,
    params.notes,
    params.body,
    params.message,
    params.customInstructions,
    params.instructions,
    params.analysisType,
    params.mode,
    params.surface,
    params.workspace,
    params.title,
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Infer which property workspace analysis mode to run.
 */
export function inferPropertyAnalysisMode(params = {}) {
  const explicit = String(params.analysisType || params.mode || params.surface || params.workspace || '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');

  const aliases = {
    auto: 'auto',
    overview: 'overview',
    analytics: 'analytics',
    finance: 'analytics',
    financials: 'analytics',
    refinance: 'refinance',
    cash_out: 'refinance',
    cashout: 'refinance',
    cash_out_refinance: 'refinance',
    rental_pricing: 'rental_pricing',
    rentalpricingpower: 'rental_pricing',
    rental_pricing_power: 'rental_pricing',
    pricing_power: 'rental_pricing',
    rent_reset: 'rental_pricing',
    rent_suggestion: 'rental_pricing',
    environmental_risk: 'environmental_risk',
    environmentalrisk: 'environmental_risk',
    environmental: 'environmental_risk',
    flood_risk: 'environmental_risk',
    wildfire: 'environmental_risk',
    full: 'full',
    everything: 'full',
  };

  if (aliases[explicit]) return aliases[explicit];

  const haystack = haystackFrom(params);

  if (/\b(full|complete|everything|all.?around|holistic)\b.*\b(analy|review|look)\b|\banalyze\s+(the\s+)?(whole|entire)\s+property\b/.test(haystack)) {
    return 'full';
  }
  if (/\brental\s+pricing(\s+power)?\b|\bpricing\s+power\b|\brent\s+reset\b|\breset\s+(the\s+)?rent\b|\bmarket\s+rent\b|\brent\s+(rate\s+)?suggestion\b|\bunder\s*market\b|\bover\s*market\b|\braise\s+rent\b|\bincrease\s+rent\b/.test(haystack)) {
    return 'rental_pricing';
  }
  if (/\benvironmental(\s+risk)?\b|\bflood\s+risk\b|\bwildfire\b|\bfire\s+risk\b|\bair\s+quality\b|\bFEMA\b|\bhazard\b|\bmitigation\b/.test(haystack)) {
    return 'environmental_risk';
  }
  if (/\bcash[-\s]?out\b|\brefi(nance)?\b|\bpull\s+out\s+equity\b|\btake\s+out\s+equity\b/.test(haystack)) {
    return 'refinance';
  }
  if (/\boverview\b|\bmortgage\s+rate\b|\bproperty\s+summary\b|\bbasic\s+(stats|info)\b/.test(haystack)) {
    return 'overview';
  }
  if (/\banalytics\b|\bcash\s*flow\b|\bnoi\b|\bcap\s*rate\b|\bequity\b|\bdebt\s+service\b/.test(haystack)) {
    return 'analytics';
  }
  if (/\banalyze\b|\banalysis\b|\blook\s+at\b|\breview\b/.test(haystack)) {
    return 'full';
  }

  return 'auto';
}

export function workspaceForAnalysisMode(mode) {
  switch (mode) {
    case 'rental_pricing':
      return 'rentalPricingPower';
    case 'environmental_risk':
      return 'environmentalRisk';
    case 'overview':
      return 'overview';
    case 'refinance':
    case 'analytics':
    case 'full':
    case 'auto':
    default:
      return mode === 'overview' ? 'overview' : 'analytics';
  }
}

/**
 * Infer a management / navigation workspace when the user is not asking for analysis.
 */
export function inferPlatformWorkspace(params = {}) {
  const haystack = haystackFrom(params);
  let best = null;
  let bestScore = 0;

  for (const [id, workspace] of Object.entries(PLATFORM_WORKSPACES)) {
    let score = 0;
    for (const keyword of workspace.keywords) {
      if (haystack.includes(keyword)) score += keyword.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { id, ...workspace };
    }
  }

  return bestScore > 0 ? best : null;
}

/**
 * Map a free-form owner request to the best executable action id + params.
 * Used when the model picks a vague action or when we need a fallback router.
 */
export function routeAssistantCapability(params = {}) {
  const haystack = haystackFrom(params);
  const propertyAddress = params.propertyAddress || params.address || params.location || null;

  // Explicit “open / go to” navigation before analysis/management execution
  if (/\b(open|go\s+to|take\s+me\s+to)\b/.test(haystack)) {
    // Opening an existing document type (pet addendum, lease, etc.) is find — not create.
    if (/\b(pet\s+addendum|lease\s+amendment|lease\s+agreement|document|addendum|checklist|notice)\b/.test(haystack)
      && !/\b(create|make|draft|generate|new)\b/.test(haystack)) {
      return {
        actionId: 'list-documents',
        parameters: { ...params, propertyAddress },
      };
    }
    const workspace = inferPlatformWorkspace(params);
    if (workspace) {
      return {
        actionId: 'open-platform-workspace',
        parameters: {
          ...params,
          workspaceId: workspace.id,
          propertyAddress,
        },
      };
    }
  }

  // Find / list existing documents before create — include “latest” phrasing
  if (/\b(find|show|list|open|view|existing|my|latest|recent)\b.*\b(pet\s+addendum|lease|document|addendum|checklist|notice)\b/.test(haystack)
    || /\b(pet\s+addendum|lease\s+amendment)s?\b/.test(haystack)) {
    if (!/\b(create|make|draft|generate|new)\b/.test(haystack)) {
      return {
        actionId: 'list-documents',
        parameters: { ...params, propertyAddress },
      };
    }
  }

  // Document creation / e-sign
  if (/\bcreate\s+(a\s+)?(lease|document|addendum|pet\s+addendum)\b|\bmake\s+(a\s+)?(lease|document|addendum)\b|\bdraft\s+(a\s+)?(lease|document|addendum|pet\s+addendum)\b|\bgenerate\s+(a\s+)?(lease|document|addendum)\b|\bnew\s+pet\s+addendum\b/.test(haystack)) {
    return {
      actionId: 'create-document',
      parameters: { ...params, propertyAddress },
    };
  }
  if (/\bpet\s+addendum\b|\blease\s+amendment\b/.test(haystack) && /\b(create|make|draft|generate|new)\b/.test(haystack)) {
    return {
      actionId: 'create-document',
      parameters: { ...params, propertyAddress },
    };
  }
  if (/\brequest\s+(an?\s+)?e-?sign|\bsend\s+.*\s+for\s+signature\b/.test(haystack)) {
    return {
      actionId: 'request-document-esignature',
      parameters: { ...params, propertyAddress },
    };
  }

  // Tenant messaging / rent
  if (/\blate\s+(rent|payment)\b|\boverdue\s+rent\b/.test(haystack)) {
    return { actionId: 'send-late-payment-alert', parameters: { ...params, propertyAddress } };
  }
  if (/\bmessage\s+(the\s+)?tenant\b|\btext\s+(the\s+)?tenant\b|\btell\s+(the\s+)?tenant\b/.test(haystack)) {
    return { actionId: 'draft-tenant-message', parameters: { ...params, propertyAddress } };
  }
  if (/\bset\s+(the\s+)?rent\b|\bchange\s+(the\s+)?rent\b|\bupdate\s+(the\s+)?rent\b|\bnew\s+rent\s+(is|to)\b/.test(haystack)
    && !/\bsuggest\b|\brecommend\b|\banalyz|\bpricing\s+power\b|\bmarket\s+rent\b|\breset\b/.test(haystack)) {
    return { actionId: 'set-tenant-rent-rate', parameters: { ...params, propertyAddress } };
  }

  // Bookkeeping / tax — year-scoped actual income/expenses before modeled analysis
  if (/\bschedule\s*e\b|\birs\s+tax\b|\btax\s+pdf\b|\bform\s+4562\b/.test(haystack)) {
    return { actionId: 'download-irs-tax-file', parameters: { ...params, propertyAddress } };
  }
  if (
    /\b(20\d{2})\b/.test(haystack)
    && /\b(rental\s+income|rents?\s+received|income\s+collected|collected|gross\s+rent|how\s+much\s+(did\s+i\s+)?(make|collect|earn)|what\s+(did|was)\s+(my|the)\s+(rent|income))\b/.test(haystack)
  ) {
    const yearMatch = haystack.match(/\b(20\d{2})\b/);
    return {
      actionId: 'show-bookkeeping-expenses',
      parameters: {
        ...params,
        propertyAddress,
        year: yearMatch ? Number(yearMatch[1]) : params.year,
        taxYear: yearMatch ? Number(yearMatch[1]) : params.taxYear,
        includeIncome: true,
        category: params.category || 'rent income',
        requestSummary: params.requestSummary || `Posted rental income for ${yearMatch?.[1] || 'selected year'}`,
      },
    };
  }
  if (/\bexpense|bookkeeping|mortgage\s+interest|management\s+fee|ledger|rental\s+income|rents?\s+received\b/.test(haystack)) {
    return {
      actionId: 'show-bookkeeping-expenses',
      parameters: {
        ...params,
        propertyAddress,
        includeIncome: /\bincome|rent/.test(haystack) ? true : params.includeIncome,
      },
    };
  }

  // Maintenance
  if (/\bmaintenance\b|\bplumber\b|\brepair\b|\bbook\s+(a\s+)?(plumber|provider)\b|\bhvac\b|\bwork\s+order\b/.test(haystack)) {
    if (/\bfollow\s*up|status|what.?s\s+going\s+on/.test(haystack)) {
      return { actionId: 'follow-up-maintenance-request', parameters: { ...params, propertyAddress } };
    }
    return { actionId: 'book-maintenance-provider', parameters: { ...params, propertyAddress } };
  }

  // Schedule
  if (/\bschedule\b|\btomorrow\s+at\b|\btoday\s+at\b|\bmonday\s+at\b|\bfriday\s+at\b|\bremind\s+me\b/.test(haystack)) {
    return { actionId: 'schedule-ai-task', parameters: { ...params, propertyAddress } };
  }

  // Sensors / predictive maintenance (before broad property analysis)
  // Prefer analytics deep-link when the owner asks about the Analytics tab or risk layers.
  if (
    /\bpredictive\s+maintenance\b|\bsensors?\b|\bflood\s+sensors?\b|\biot\b|\bleak\b|\bmold\s+(risk|zone|index)\b|\bfreeze\s+risk\b|\binsulation\s+(grade|risk)\b/.test(haystack)
    && !/\benvironmental\s+risk\b|\bflood\s+risk\b|\bwildfire\b/.test(haystack)
  ) {
    const wantsAnalytics = /\banalytics\b|\bmold\b|\bfreeze\b|\binsulation\b|\bhumidity\b|\btemperature\s+chart\b|\brisk\s+layer\b/.test(haystack);
    const wantsAlerts = /\balerts?\b/.test(haystack) && !wantsAnalytics;
    let layer = null;
    if (/\bmold\b/.test(haystack)) layer = 'mold';
    else if (/\bfreeze\b/.test(haystack)) layer = 'freeze';
    else if (/\binsulation\b/.test(haystack)) layer = 'insulation';
    else if (/\bconditions\b/.test(haystack)) layer = 'conditions';

    if (/\b(open|go\s+to|take\s+me\s+to|show|switch)\b/.test(haystack) && (wantsAnalytics || wantsAlerts || layer)) {
      return {
        actionId: 'open-platform-workspace',
        parameters: {
          ...params,
          propertyAddress,
          workspaceId: wantsAlerts ? 'sensors_alerts' : wantsAnalytics || layer ? 'sensors_analytics' : 'sensors',
          layer: layer || undefined,
        },
      };
    }

    return {
      actionId: 'analyze-sensor-data',
      parameters: {
        ...params,
        propertyAddress,
        view: wantsAlerts ? 'alerts' : wantsAnalytics || layer ? 'analytics' : 'overview',
        layer: layer || undefined,
      },
    };
  }
  if (/\bmarket\s+data\b|\bmortgage\s+rate\b|\bfed\s+meeting\b|\btreasury\b/.test(haystack)
    && !propertyAddress
    && !/\bproperty\b|\brefi|\brent\b/.test(haystack)) {
    return { actionId: 'analyze-market-insight', parameters: params };
  }

  // Property analysis (any surface)
  if (propertyAddress || /\bproperty\b|\bprestwick\b|\banaly[sz]e\b|\brefi|\brent|\benvironmental|\bpricing\s+power\b|\bflood\s+risk\b|\bwildfire\b/.test(haystack)) {
    const mode = inferPropertyAnalysisMode(params);
    return {
      actionId: 'analyze-property',
      parameters: {
        ...params,
        propertyAddress,
        analysisType: mode === 'auto' ? 'full' : mode,
      },
    };
  }

  // Market / sensors fallback
  if (/\bmarket\b|\bmortgage\s+rate\b|\bfed\b/.test(haystack)) {
    return { actionId: 'analyze-market-insight', parameters: params };
  }
  if (/\bsensors?\b|\bflood\s+sensors?\b|\biot\b|\bpredictive\s+maintenance\b/.test(haystack)) {
    return { actionId: 'analyze-sensor-data', parameters: params };
  }

  const workspace = inferPlatformWorkspace(params);
  if (workspace) {
    return {
      actionId: 'open-platform-workspace',
      parameters: {
        ...params,
        workspaceId: workspace.id,
        propertyAddress,
      },
    };
  }

  return null;
}

export function buildPropertyWorkspaceRoute({
  propertyId = '',
  address = '',
  workspace = 'analytics',
} = {}) {
  const params = new URLSearchParams();
  params.set('tab', 'properties');
  if (propertyId) params.set('property', propertyId);
  if (address) params.set('address', address);
  if (workspace) params.set('workspace', workspace);
  return `/portfolio?${params.toString()}`;
}
