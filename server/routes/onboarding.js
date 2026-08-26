/**
 * Owner onboarding routes (platform-level).
 *
 * Persists resumable onboarding state on the Firestore `users` doc and exposes
 * get/update/complete endpoints. All routes require Firebase auth and derive the
 * ownerId from the verified token — the client never supplies ownerId.
 *
 * Mounted at /api/onboarding from server/index.js.
 */

import express from 'express';
import { requireAuth, getFirestore } from '../firebase-admin.js';
import { isValidPlanId } from '../config/plans.js';

const router = express.Router();

const USERS_COLLECTION = 'users';

const ONBOARDING_STATUSES = new Set(['not_started', 'in_progress', 'complete']);
const BUSINESS_TYPES = new Set(['individual', 'llc', 'corp', 'trust']);

/**
 * Derive the canonical onboarding-state view from a Firestore user doc.
 * Pre-existing users without an onboardingStatus are grandfathered as complete
 * so we never lock established accounts out of the app.
 */
function deriveOnboardingState(userData = {}, { isNewlyMissing = false } = {}) {
  const hasOnboardingField = Object.prototype.hasOwnProperty.call(userData, 'onboardingStatus')
    && ONBOARDING_STATUSES.has(userData.onboardingStatus);

  const onboardingStatus = hasOnboardingField
    ? userData.onboardingStatus
    : (isNewlyMissing ? 'not_started' : 'complete'); // grandfather existing users

  return {
    onboardingStatus,
    onboardingStep: Number.isInteger(userData.onboardingStep) ? userData.onboardingStep : 0,
    selectedPlanId: isValidPlanId(userData.selectedPlanId) ? userData.selectedPlanId : null,
    ownerProfile: userData.ownerProfile || null,
    payout: userData.payout || { connected: false, accountId: null },
    propertyIds: Array.isArray(userData.onboardingPropertyIds) ? userData.onboardingPropertyIds : [],
    invitedTenants: Array.isArray(userData.onboardingInvitedTenants) ? userData.onboardingInvitedTenants : [],
    // Billing (mirrored by subscriptions route)
    planId: isValidPlanId(userData.planId) ? userData.planId : null,
    subscriptionStatus: userData.subscriptionStatus || 'none',
    stripeCustomerId: userData.stripeCustomerId || null,
    stripeSubscriptionId: userData.stripeSubscriptionId || null,
    grandfathered: !hasOnboardingField && !isNewlyMissing,
  };
}

function sanitizeOwnerProfile(input) {
  if (!input || typeof input !== 'object') return null;
  const addr = input.mailingAddress && typeof input.mailingAddress === 'object' ? input.mailingAddress : {};
  const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const businessType = BUSINESS_TYPES.has(input.businessType) ? input.businessType : 'individual';

  return {
    fullName: str(input.fullName, 120),
    phone: str(input.phone, 40),
    companyName: str(input.companyName, 160),
    legalEntityName: str(input.legalEntityName, 160),
    businessType,
    mailingAddress: {
      line1: str(addr.line1, 200),
      line2: str(addr.line2, 200),
      city: str(addr.city, 120),
      state: str(addr.state, 60),
      postalCode: str(addr.postalCode, 20),
      country: str(addr.country, 60) || 'US',
    },
  };
}

/** GET /api/onboarding/state — current onboarding state for the authed user. */
router.get('/state', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const db = getFirestore();
    const ref = db.collection(USERS_COLLECTION).doc(ownerId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.json({ ok: true, state: deriveOnboardingState({}, { isNewlyMissing: true }) });
    }

    return res.json({ ok: true, state: deriveOnboardingState(snap.data() || {}) });
  } catch (error) {
    console.error('[Onboarding] get state error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * PUT /api/onboarding/state — patch resumable onboarding state.
 * Accepts: { onboardingStatus, onboardingStep, selectedPlanId, ownerProfile,
 *            payout, propertyIds, invitedTenants }.
 */
router.put('/state', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const db = getFirestore();
    const ref = db.collection(USERS_COLLECTION).doc(ownerId);

    const updates = { updatedAt: new Date().toISOString() };
    const body = req.body || {};

    if (typeof body.onboardingStatus === 'string') {
      if (!ONBOARDING_STATUSES.has(body.onboardingStatus)) {
        return res.status(400).json({ ok: false, error: 'invalid_onboarding_status' });
      }
      updates.onboardingStatus = body.onboardingStatus;
    }

    if (body.onboardingStep !== undefined) {
      const step = Number(body.onboardingStep);
      if (!Number.isInteger(step) || step < 0 || step > 20) {
        return res.status(400).json({ ok: false, error: 'invalid_onboarding_step' });
      }
      updates.onboardingStep = step;
    }

    if (body.selectedPlanId !== undefined) {
      if (body.selectedPlanId !== null && !isValidPlanId(body.selectedPlanId)) {
        return res.status(400).json({ ok: false, error: 'invalid_plan_id' });
      }
      updates.selectedPlanId = body.selectedPlanId;
    }

    if (body.ownerProfile !== undefined) {
      updates.ownerProfile = sanitizeOwnerProfile(body.ownerProfile);
    }

    if (body.payout !== undefined && body.payout && typeof body.payout === 'object') {
      updates.payout = {
        connected: Boolean(body.payout.connected),
        accountId: typeof body.payout.accountId === 'string' ? body.payout.accountId : null,
      };
    }

    if (Array.isArray(body.propertyIds)) {
      updates.onboardingPropertyIds = body.propertyIds
        .filter((id) => typeof id === 'string')
        .slice(0, 500);
    }

    if (Array.isArray(body.invitedTenants)) {
      updates.onboardingInvitedTenants = body.invitedTenants
        .filter((t) => t && typeof t === 'object')
        .slice(0, 1000)
        .map((t) => ({
          email: typeof t.email === 'string' ? t.email.slice(0, 200) : '',
          name: typeof t.name === 'string' ? t.name.slice(0, 120) : '',
          propertyId: typeof t.propertyId === 'string' ? t.propertyId : '',
          status: typeof t.status === 'string' ? t.status.slice(0, 40) : 'invited',
          invitedAt: typeof t.invitedAt === 'string' ? t.invitedAt : new Date().toISOString(),
        }));
    }

    // If onboarding is moving forward and was previously unset, mark in_progress.
    const snap = await ref.get();
    if (!updates.onboardingStatus && snap.exists) {
      const current = snap.data() || {};
      if (!ONBOARDING_STATUSES.has(current.onboardingStatus)) {
        updates.onboardingStatus = 'in_progress';
      }
    } else if (!updates.onboardingStatus && !snap.exists) {
      updates.onboardingStatus = 'in_progress';
    }

    await ref.set(updates, { merge: true });
    const after = await ref.get();
    return res.json({ ok: true, state: deriveOnboardingState(after.data() || {}) });
  } catch (error) {
    console.error('[Onboarding] update state error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/onboarding/complete — finalize onboarding.
 * Requires an active subscription unless STRIPE is not configured (dev bypass via
 * allowWithoutSubscription only when explicitly enabled).
 */
router.post('/complete', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const db = getFirestore();
    const ref = db.collection(USERS_COLLECTION).doc(ownerId);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() || {} : {};

    const subscriptionActive = data.subscriptionStatus === 'active' || data.subscriptionStatus === 'trialing';
    const allowWithoutSubscription = process.env.ONBOARDING_ALLOW_WITHOUT_SUBSCRIPTION === '1';

    if (!subscriptionActive && !allowWithoutSubscription) {
      return res.status(402).json({
        ok: false,
        error: 'subscription_required',
        message: 'An active subscription is required to complete onboarding.',
      });
    }

    await ref.set(
      {
        onboardingStatus: 'complete',
        onboardingCompletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );

    const after = await ref.get();
    return res.json({ ok: true, state: deriveOnboardingState(after.data() || {}) });
  } catch (error) {
    console.error('[Onboarding] complete error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
