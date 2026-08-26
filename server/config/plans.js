/**
 * Server mirror of src/config/plans.ts — HouseYield SaaS subscription plans.
 *
 * Keep this in sync with the frontend definition. Stripe Price IDs are never
 * hardcoded; they are read from environment variables named by `priceEnvVar`.
 *
 * Internal plan IDs (light / standard / premium) map to customer-facing tiers:
 *   light    → Protection    ($19/mo, 2 properties, +$10/additional)
 *   standard → Hands-Off     ($49/mo, 5 properties, +$12/additional)
 *   premium  → Fully Managed ($79/mo, 15 properties, +$8/additional)
 *
 * "Property" = one physical address. A duplex = 1 property, 2 tenants.
 * Overage rates are set so upgrading to the next tier wins at the right threshold.
 */

export const PLANS = {
  light: {
    id: 'light',
    name: 'Protection',
    description: 'Stop water damage before it starts — built for remote landlords.',
    monthlyPrice: 19,
    overagePerPropertyPerMonth: 10,
    priceEnvVar: 'STRIPE_PRICE_LIGHT',
    entitlements: {
      propertyLimit: 2,
      tenantLimit: 6,
      documentStorageMb: 1024,
      features: {
        iotProtection: true,
        maintenanceCoordination: false,
        documentManagement: true,
        tenantInvites: false,
        bankPayouts: false,
        bookkeepingAndTax: false,
        aiFinancialPlanner: false,
        advancedAnalytics: false,
        prioritySupport: false,
      },
    },
  },
  standard: {
    id: 'standard',
    name: 'Hands-Off',
    description: 'We handle the emergencies and the phone calls — you stay informed.',
    monthlyPrice: 49,
    overagePerPropertyPerMonth: 12,
    priceEnvVar: 'STRIPE_PRICE_STANDARD',
    entitlements: {
      propertyLimit: 5,
      tenantLimit: 15,
      documentStorageMb: 10240,
      features: {
        iotProtection: true,
        maintenanceCoordination: true,
        documentManagement: true,
        tenantInvites: true,
        bankPayouts: true,
        bookkeepingAndTax: false,
        aiFinancialPlanner: false,
        advancedAnalytics: true,
        prioritySupport: false,
      },
    },
  },
  premium: {
    id: 'premium',
    name: 'Fully Managed',
    description: 'Protection, maintenance, and books — one system, zero spreadsheets.',
    monthlyPrice: 79,
    overagePerPropertyPerMonth: 8,
    priceEnvVar: 'STRIPE_PRICE_PREMIUM',
    entitlements: {
      propertyLimit: 15,
      tenantLimit: 45,
      documentStorageMb: null,
      features: {
        iotProtection: true,
        maintenanceCoordination: true,
        documentManagement: true,
        tenantInvites: true,
        bankPayouts: true,
        bookkeepingAndTax: true,
        aiFinancialPlanner: true,
        advancedAnalytics: true,
        prioritySupport: true,
      },
    },
  },
};

export const PLAN_ORDER = ['light', 'standard', 'premium'];

export function isValidPlanId(value) {
  return value === 'light' || value === 'standard' || value === 'premium';
}

export function getPlan(planId) {
  if (!planId) return null;
  return PLANS[planId] || null;
}

/**
 * Resolve the Stripe Price ID for a plan from environment variables.
 * Returns null if the plan or env var is missing.
 */
export function resolvePriceId(planId) {
  const plan = getPlan(planId);
  if (!plan) return null;
  const priceId = process.env[plan.priceEnvVar];
  return priceId && priceId.trim() ? priceId.trim() : null;
}

export function isSubscriptionActive(status) {
  return status === 'active' || status === 'trialing';
}
