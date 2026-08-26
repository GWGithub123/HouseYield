/**
 * Client for the owner onboarding API (/api/onboarding).
 *
 * The server derives ownerId from the verified Firebase token, so no ownerId is
 * ever sent from the client. State shape mirrors server deriveOnboardingState().
 */

import type { PlanId, SubscriptionStatus } from '../config/plans';
import {
  buildOwnerFinanceUrl,
  requestOwnerFinanceJson,
} from './ownerFinanceApi';

export type OnboardingStatus = 'not_started' | 'in_progress' | 'complete';
export type BusinessType = 'individual' | 'llc' | 'corp' | 'trust';

export interface MailingAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface OwnerProfile {
  fullName: string;
  phone: string;
  companyName: string;
  legalEntityName: string;
  businessType: BusinessType;
  mailingAddress: MailingAddress;
}

export interface OnboardingPayout {
  connected: boolean;
  accountId: string | null;
}

export interface InvitedTenantRecord {
  email: string;
  name: string;
  propertyId: string;
  status: string;
  invitedAt: string;
}

export interface OnboardingState {
  onboardingStatus: OnboardingStatus;
  onboardingStep: number;
  selectedPlanId: PlanId | null;
  ownerProfile: OwnerProfile | null;
  payout: OnboardingPayout;
  propertyIds: string[];
  invitedTenants: InvitedTenantRecord[];
  planId: PlanId | null;
  subscriptionStatus: SubscriptionStatus | string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  grandfathered?: boolean;
}

export interface OnboardingStatePatch {
  onboardingStatus?: OnboardingStatus;
  onboardingStep?: number;
  selectedPlanId?: PlanId | null;
  ownerProfile?: OwnerProfile | null;
  payout?: OnboardingPayout;
  propertyIds?: string[];
  invitedTenants?: InvitedTenantRecord[];
}

function unwrap<T>(payload: any, key: string): T {
  if (payload && payload._httpOk === false) {
    throw new Error(payload.error || payload.message || `Request failed (${payload._httpStatus})`);
  }
  if (payload && payload.ok === false) {
    throw new Error(payload.error || payload.message || 'Request failed');
  }
  return payload[key] as T;
}

export const onboardingClient = {
  async getState(): Promise<OnboardingState> {
    const payload = await requestOwnerFinanceJson(buildOwnerFinanceUrl('/api/onboarding/state'));
    return unwrap<OnboardingState>(payload, 'state');
  },

  async updateState(patch: OnboardingStatePatch): Promise<OnboardingState> {
    const payload = await requestOwnerFinanceJson(
      buildOwnerFinanceUrl('/api/onboarding/state'),
      { method: 'PUT', body: JSON.stringify(patch) },
      { 'Content-Type': 'application/json' },
    );
    return unwrap<OnboardingState>(payload, 'state');
  },

  async complete(): Promise<OnboardingState> {
    const payload = await requestOwnerFinanceJson(
      buildOwnerFinanceUrl('/api/onboarding/complete'),
      { method: 'POST', body: '{}' },
      { 'Content-Type': 'application/json' },
    );
    return unwrap<OnboardingState>(payload, 'state');
  },
};
