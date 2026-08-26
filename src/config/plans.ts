/**
 * HouseYield SaaS subscription plans (platform-level billing).
 *
 * This is the SHARED CONTRACT for plan metadata + entitlements. It is mirrored
 * on the backend in `server/config/plans.js`. Keep the two in sync.
 *
 * NOTE: This is the monthly HouseYield software subscription billed via Stripe
 * Billing. It is SEPARATE from Stripe Connect (landlord rent payouts).
 *
 * Internal plan IDs (light / standard / premium) map to customer-facing tiers:
 *   light    → Protection   ($19/mo, up to 2 properties)
 *   standard → Hands-Off    ($49/mo, up to 5 properties)
 *   premium  → Fully Managed($79/mo, up to 15 properties)
 *
 * Overage pricing (charged per additional property/unit above the plan limit):
 *   Protection:    +$10/property/mo  → upgrade to Hands-Off wins at 5 properties
 *   Hands-Off:     +$12/property/mo  → upgrade to Fully Managed wins at 8 properties
 *   Fully Managed: +$8/property/mo   → enterprise conversation above ~20 properties
 *
 * "Property" = one physical address. A duplex is 1 property with 2 units/tenants.
 * The tenantLimit handles multi-unit buildings (roughly 3 tenants per property).
 * Additional units beyond the tenantLimit also require overage or an upgrade.
 */

export type PlanId = 'light' | 'standard' | 'premium';

export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

export interface PlanEntitlements {
  /** Max number of properties (addresses) the owner can manage. */
  propertyLimit: number;
  /** Max number of tenants across all properties. null = unlimited. */
  tenantLimit: number | null;
  /** Document storage allowance in megabytes. null = unlimited. */
  documentStorageMb: number | null;
  /** Feature flags gated by plan. */
  features: {
    iotProtection: boolean;
    maintenanceCoordination: boolean;
    documentManagement: boolean;
    tenantInvites: boolean;
    bankPayouts: boolean;
    bookkeepingAndTax: boolean;
    aiFinancialPlanner: boolean;
    advancedAnalytics: boolean;
    prioritySupport: boolean;
  };
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  description: string;
  /** Monthly base price in USD for the included property limit. */
  monthlyPrice: number;
  /**
   * Additional monthly charge per property above the plan's propertyLimit.
   * Designed so that upgrading to the next tier wins at the right threshold.
   *   Protection  +$10/property → upgrade to Hands-Off wins at property #5
   *   Hands-Off   +$12/property → upgrade to Fully Managed wins at property #8
   *   FullyMgd    +$8/property  → enterprise conversation above ~20 properties
   */
  overagePerPropertyPerMonth: number;
  /**
   * Name of the env var (read on the server) that holds the Stripe Price ID for
   * this plan's monthly recurring base price. Never hardcode the price id here.
   */
  priceEnvVar: string;
  highlights: string[];
  entitlements: PlanEntitlements;
  recommended?: boolean;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  light: {
    id: 'light',
    name: 'Protection',
    description: 'Stop water damage before it starts — built for remote landlords.',
    monthlyPrice: 19,
    overagePerPropertyPerMonth: 10,
    priceEnvVar: 'STRIPE_PRICE_LIGHT',
    highlights: [
      'Leak sensors + auto shut-off valve monitoring',
      'Instant alerts when something goes wrong',
      'Remote property status dashboard',
      'Up to 2 properties — $10/mo per additional',
    ],
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
    recommended: true,
    highlights: [
      'Everything in Protection',
      'Maintenance scheduling & vendor coordination',
      'Tenant invites & rent collection',
      'Monthly income report delivered to your inbox',
      'Up to 5 properties — $12/mo per additional',
    ],
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
    highlights: [
      'Everything in Hands-Off',
      'Automated bookkeeping & expense tracking',
      'End-of-year tax summary for your accountant',
      'Up to 15 properties — $8/mo per additional',
      'Priority support',
    ],
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

export const PLAN_ORDER: PlanId[] = ['light', 'standard', 'premium'];

export function getPlan(planId: PlanId | null | undefined): PlanDefinition | null {
  if (!planId) return null;
  return PLANS[planId] ?? null;
}

export function isValidPlanId(value: unknown): value is PlanId {
  return value === 'light' || value === 'standard' || value === 'premium';
}

/** Subscription statuses that grant full access to gated features. */
export function isSubscriptionActive(status: SubscriptionStatus | string | null | undefined): boolean {
  return status === 'active' || status === 'trialing';
}

export function formatPlanPrice(plan: PlanDefinition): string {
  return `$${plan.monthlyPrice}/mo`;
}

/**
 * Calculate the total monthly bill for a given plan and actual property/unit count.
 * Returns the base price plus any overage charges.
 */
export function calculateMonthlyBill(
  plan: PlanDefinition,
  propertyCount: number,
  tenantCount: number,
): { base: number; propertyOverage: number; total: number; overageProperties: number } {
  const overageProperties = Math.max(0, propertyCount - plan.entitlements.propertyLimit);
  const propertyOverage = overageProperties * plan.overagePerPropertyPerMonth;
  const base = plan.monthlyPrice;
  return { base, propertyOverage, total: base + propertyOverage, overageProperties };
}
