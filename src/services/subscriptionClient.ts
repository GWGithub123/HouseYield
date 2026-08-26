/**
 * Client for the platform subscription API (/api/subscriptions).
 * Stripe Billing for the monthly HouseYield SaaS plan (separate from Connect).
 */

import type { PlanId, SubscriptionStatus } from '../config/plans';
import {
  buildOwnerFinanceUrl,
  requestOwnerFinanceJson,
} from './ownerFinanceApi';

export interface SubscriptionStatusResponse {
  status: SubscriptionStatus | string;
  planId: PlanId | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

function assertOk(payload: any): any {
  if (payload && payload._httpOk === false) {
    throw new Error(payload.error || payload.message || `Request failed (${payload._httpStatus})`);
  }
  if (payload && payload.ok === false) {
    throw new Error(payload.message || payload.error || 'Request failed');
  }
  return payload;
}

export const subscriptionClient = {
  async createCustomer(): Promise<{ customerId: string }> {
    const payload = assertOk(
      await requestOwnerFinanceJson(
        buildOwnerFinanceUrl('/api/subscriptions/create-customer'),
        { method: 'POST', body: '{}' },
        { 'Content-Type': 'application/json' },
      ),
    );
    return { customerId: payload.customerId };
  },

  /** Create a hosted Stripe Checkout session and return its redirect URL. */
  async createCheckoutSession(planId: PlanId): Promise<{ url: string; sessionId: string }> {
    const payload = assertOk(
      await requestOwnerFinanceJson(
        buildOwnerFinanceUrl('/api/subscriptions/create-checkout-session'),
        { method: 'POST', body: JSON.stringify({ planId }) },
        { 'Content-Type': 'application/json' },
      ),
    );
    return { url: payload.url, sessionId: payload.sessionId };
  },

  /** PaymentElement flow: create incomplete subscription, returns client secret. */
  async createSubscription(planId: PlanId): Promise<{ subscriptionId: string; clientSecret: string | null }> {
    const payload = assertOk(
      await requestOwnerFinanceJson(
        buildOwnerFinanceUrl('/api/subscriptions/create-subscription'),
        { method: 'POST', body: JSON.stringify({ planId }) },
        { 'Content-Type': 'application/json' },
      ),
    );
    return { subscriptionId: payload.subscriptionId, clientSecret: payload.clientSecret };
  },

  async getStatus(): Promise<SubscriptionStatusResponse> {
    const payload = assertOk(
      await requestOwnerFinanceJson(buildOwnerFinanceUrl('/api/subscriptions/status')),
    );
    return {
      status: payload.status,
      planId: payload.planId ?? null,
      currentPeriodEnd: payload.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(payload.cancelAtPeriodEnd),
      stripeCustomerId: payload.stripeCustomerId ?? null,
      stripeSubscriptionId: payload.stripeSubscriptionId ?? null,
    };
  },

  async cancel(immediate = false): Promise<{ status: string; cancelAtPeriodEnd: boolean }> {
    const payload = assertOk(
      await requestOwnerFinanceJson(
        buildOwnerFinanceUrl('/api/subscriptions/cancel'),
        { method: 'POST', body: JSON.stringify({ immediate }) },
        { 'Content-Type': 'application/json' },
      ),
    );
    return { status: payload.status, cancelAtPeriodEnd: Boolean(payload.cancelAtPeriodEnd) };
  },

  async changePlan(planId: PlanId): Promise<{ status: string; planId: PlanId }> {
    const payload = assertOk(
      await requestOwnerFinanceJson(
        buildOwnerFinanceUrl('/api/subscriptions/change-plan'),
        { method: 'POST', body: JSON.stringify({ planId }) },
        { 'Content-Type': 'application/json' },
      ),
    );
    return { status: payload.status, planId: payload.planId };
  },
};
