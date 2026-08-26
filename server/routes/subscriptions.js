/**
 * Platform subscription routes — HouseYield monthly SaaS billing via Stripe Billing.
 *
 * This is SEPARATE from Stripe Connect (server/stripe-connect.js), which handles
 * landlord rent payouts. Here we bill owners for their HouseYield plan.
 *
 * Mounted at /api/subscriptions from server/index.js. The /webhook route is
 * registered with express.raw in index.js BEFORE the global JSON body parser so
 * Stripe signature verification works.
 *
 * Required env:
 *   STRIPE_SECRET_KEY                 (shared with stripe-connect)
 *   STRIPE_PRICE_LIGHT ($39 Protection) / _STANDARD ($69 Hands-Off) / _PREMIUM ($99 Fully Managed)
 *   STRIPE_SUBSCRIPTION_WEBHOOK_SECRET          (webhook signing secret)
 *   FRONTEND_URL                      (for Checkout success/cancel redirects)
 */

import express from 'express';
import Stripe from 'stripe';
import { requireAuth, getFirestore } from '../firebase-admin.js';
import { getPlan, isValidPlanId, resolvePriceId } from '../config/plans.js';

const router = express.Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required for subscriptions');
}
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });

const USERS_COLLECTION = 'users';

console.log('[Subscriptions] Initialized Stripe Billing for platform subscriptions');

function getFrontendUrl() {
  return process.env.FRONTEND_URL || process.env.PUBLIC_URL || 'http://localhost:5173';
}

async function getUserDoc(ownerId) {
  const db = getFirestore();
  const ref = db.collection(USERS_COLLECTION).doc(ownerId);
  const snap = await ref.get();
  return { ref, data: snap.exists ? snap.data() || {} : {}, exists: snap.exists };
}

async function updateUserBilling(ownerId, fields) {
  const db = getFirestore();
  await db.collection(USERS_COLLECTION).doc(ownerId).set(
    { ...fields, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}

async function findUserIdByCustomerId(customerId) {
  if (!customerId) return null;
  const db = getFirestore();
  const snap = await db.collection(USERS_COLLECTION)
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

/** Ensure a Stripe Customer exists for this owner and return its id. */
async function ensureCustomer(ownerId, email, name) {
  const { data } = await getUserDoc(ownerId);
  if (data.stripeCustomerId) {
    return data.stripeCustomerId;
  }
  const customer = await stripe.customers.create({
    email: email || data.email || undefined,
    name: name || data.name || undefined,
    metadata: { ownerId, houseyield: 'platform_subscription' },
  });
  await updateUserBilling(ownerId, { stripeCustomerId: customer.id });
  return customer.id;
}

function planFromSubscription(subscription) {
  // Match the subscription's price id back to a plan via env vars.
  const priceId = subscription?.items?.data?.[0]?.price?.id;
  if (!priceId) return subscription?.metadata?.planId || null;
  for (const planId of ['light', 'standard', 'premium']) {
    if (resolvePriceId(planId) === priceId) return planId;
  }
  return subscription?.metadata?.planId || null;
}

// ---------------------------------------------------------------------------
// POST /api/subscriptions/create-customer
// ---------------------------------------------------------------------------
router.post('/create-customer', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const email = req.user.email || (req.body && req.body.email);
    const name = req.body && req.body.name;
    const customerId = await ensureCustomer(ownerId, email, name);
    return res.json({ ok: true, customerId });
  } catch (error) {
    console.error('[Subscriptions] create-customer error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions/create-checkout-session  { planId }
// Returns a hosted Stripe Checkout URL (subscription mode, card + ACH).
// ---------------------------------------------------------------------------
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const { planId } = req.body || {};

    if (!isValidPlanId(planId)) {
      return res.status(400).json({ ok: false, error: 'invalid_plan_id' });
    }
    const priceId = resolvePriceId(planId);
    if (!priceId) {
      return res.status(503).json({
        ok: false,
        error: 'price_not_configured',
        message: `Stripe Price ID for plan "${planId}" is not configured. Set ${getPlan(planId).priceEnvVar}.`,
      });
    }

    const customerId = await ensureCustomer(ownerId, req.user.email);
    const frontend = getFrontendUrl();

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: ownerId,
      line_items: [{ price: priceId, quantity: 1 }],
      payment_method_types: ['card', 'us_bank_account'],
      subscription_data: {
        metadata: { ownerId, planId },
      },
      metadata: { ownerId, planId },
      success_url: `${frontend}/onboarding?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend}/onboarding?subscription=cancel`,
      allow_promotion_codes: true,
    });

    // Persist the intended plan immediately so the wizard can resume.
    await updateUserBilling(ownerId, { selectedPlanId: planId });

    return res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('[Subscriptions] create-checkout-session error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions/create-subscription  { planId }
// PaymentElement flow: creates an incomplete subscription and returns the
// client secret of the first invoice's PaymentIntent for in-app card collection.
// ---------------------------------------------------------------------------
router.post('/create-subscription', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const { planId } = req.body || {};

    if (!isValidPlanId(planId)) {
      return res.status(400).json({ ok: false, error: 'invalid_plan_id' });
    }
    const priceId = resolvePriceId(planId);
    if (!priceId) {
      return res.status(503).json({
        ok: false,
        error: 'price_not_configured',
        message: `Stripe Price ID for plan "${planId}" is not configured. Set ${getPlan(planId).priceEnvVar}.`,
      });
    }

    const customerId = await ensureCustomer(ownerId, req.user.email);

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { ownerId, planId },
    });

    await updateUserBilling(ownerId, {
      selectedPlanId: planId,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
    });

    const clientSecret = subscription.latest_invoice?.payment_intent?.client_secret || null;
    return res.json({ ok: true, subscriptionId: subscription.id, clientSecret });
  } catch (error) {
    console.error('[Subscriptions] create-subscription error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/subscriptions/status
// ---------------------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const { data } = await getUserDoc(ownerId);

    let status = data.subscriptionStatus || 'none';
    let planId = isValidPlanId(data.planId) ? data.planId : null;
    let currentPeriodEnd = data.subscriptionCurrentPeriodEnd || null;
    let cancelAtPeriodEnd = Boolean(data.subscriptionCancelAtPeriodEnd);

    // Refresh from Stripe when we have a subscription id (source of truth).
    if (data.stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(data.stripeSubscriptionId);
        status = sub.status;
        planId = planFromSubscription(sub) || planId;
        currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : currentPeriodEnd;
        cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
        // Keep Firestore in sync.
        await updateUserBilling(ownerId, {
          subscriptionStatus: status,
          planId: planId || null,
          subscriptionCurrentPeriodEnd: currentPeriodEnd,
          subscriptionCancelAtPeriodEnd: cancelAtPeriodEnd,
        });
      } catch (err) {
        console.warn('[Subscriptions] status refresh failed:', err.message);
      }
    }

    return res.json({
      ok: true,
      status,
      planId,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      stripeCustomerId: data.stripeCustomerId || null,
      stripeSubscriptionId: data.stripeSubscriptionId || null,
    });
  } catch (error) {
    console.error('[Subscriptions] status error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions/cancel   { immediate?: boolean }
// ---------------------------------------------------------------------------
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const { data } = await getUserDoc(ownerId);
    if (!data.stripeSubscriptionId) {
      return res.status(404).json({ ok: false, error: 'no_subscription' });
    }

    const immediate = Boolean(req.body && req.body.immediate);
    let sub;
    if (immediate) {
      sub = await stripe.subscriptions.cancel(data.stripeSubscriptionId);
    } else {
      sub = await stripe.subscriptions.update(data.stripeSubscriptionId, { cancel_at_period_end: true });
    }

    await updateUserBilling(ownerId, {
      subscriptionStatus: sub.status,
      subscriptionCancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    });

    return res.json({ ok: true, status: sub.status, cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) });
  } catch (error) {
    console.error('[Subscriptions] cancel error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions/change-plan   { planId }  (upgrade/downgrade)
// ---------------------------------------------------------------------------
router.post('/change-plan', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.uid;
    const { planId } = req.body || {};
    if (!isValidPlanId(planId)) {
      return res.status(400).json({ ok: false, error: 'invalid_plan_id' });
    }
    const priceId = resolvePriceId(planId);
    if (!priceId) {
      return res.status(503).json({ ok: false, error: 'price_not_configured' });
    }

    const { data } = await getUserDoc(ownerId);
    if (!data.stripeSubscriptionId) {
      return res.status(404).json({ ok: false, error: 'no_subscription' });
    }

    const current = await stripe.subscriptions.retrieve(data.stripeSubscriptionId);
    const itemId = current.items.data[0]?.id;
    if (!itemId) {
      return res.status(409).json({ ok: false, error: 'subscription_has_no_items' });
    }

    const updated = await stripe.subscriptions.update(data.stripeSubscriptionId, {
      cancel_at_period_end: false,
      proration_behavior: 'create_prorations',
      items: [{ id: itemId, price: priceId }],
      metadata: { ...(current.metadata || {}), ownerId, planId },
    });

    await updateUserBilling(ownerId, {
      planId,
      selectedPlanId: planId,
      subscriptionStatus: updated.status,
      subscriptionCancelAtPeriodEnd: Boolean(updated.cancel_at_period_end),
    });

    return res.json({ ok: true, status: updated.status, planId });
  } catch (error) {
    console.error('[Subscriptions] change-plan error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions/webhook  (raw body; Stripe signature verified)
// ---------------------------------------------------------------------------
router.post('/webhook', async (req, res) => {
  const webhookSecret = process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } else {
      // No secret configured (local/dev): best-effort parse. NOT for production.
      console.warn('[Subscriptions] STRIPE_SUBSCRIPTION_WEBHOOK_SECRET not set; skipping signature verification');
      event = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? req.body
        : JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error('[Subscriptions] webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const ownerId = session.client_reference_id || session.metadata?.ownerId;
        if (ownerId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await updateUserBilling(ownerId, {
            stripeCustomerId: session.customer || sub.customer,
            stripeSubscriptionId: sub.id,
            planId: planFromSubscription(sub) || session.metadata?.planId || null,
            subscriptionStatus: sub.status,
            subscriptionCurrentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString() : null,
            subscriptionCancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          });
          console.log(`[Subscriptions] checkout completed for owner ${ownerId} → ${sub.status}`);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const ownerId = sub.metadata?.ownerId || (await findUserIdByCustomerId(sub.customer));
        if (ownerId) {
          await updateUserBilling(ownerId, {
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            planId: planFromSubscription(sub),
            subscriptionStatus: sub.status,
            subscriptionCurrentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString() : null,
            subscriptionCancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const ownerId = sub.metadata?.ownerId || (await findUserIdByCustomerId(sub.customer));
        if (ownerId) {
          await updateUserBilling(ownerId, {
            subscriptionStatus: 'canceled',
            subscriptionCancelAtPeriodEnd: false,
          });
        }
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const ownerId = await findUserIdByCustomerId(invoice.customer);
        if (ownerId) {
          await updateUserBilling(ownerId, {
            subscriptionStatus: 'active',
            lastInvoiceStatus: 'paid',
            lastInvoicePaidAt: new Date().toISOString(),
          });
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const ownerId = await findUserIdByCustomerId(invoice.customer);
        if (ownerId) {
          await updateUserBilling(ownerId, {
            subscriptionStatus: 'past_due',
            lastInvoiceStatus: 'failed',
            lastInvoiceFailedAt: new Date().toISOString(),
          });
        }
        break;
      }
      default:
        // Unhandled event type — acknowledge to avoid retries.
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('[Subscriptions] webhook handler error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
