function sanitizeStripeMetadata(metadata = {}) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function buildUsBankAccountCheckoutOptions() {
  return {
    financial_connections: {
      permissions: ['payment_method']
    },
    verification_method: 'automatic'
  };
}

export function buildTenantCheckoutSessionParams({
  amount,
  tenantEmail,
  description,
  propertyAddress,
  successUrl,
  cancelUrl,
  metadata = {},
  paymentIntentData = null
}) {
  const normalizedDescription = description || 'Rent Payment';

  return {
    mode: 'payment',
    payment_method_types: ['card', 'us_bank_account'],
    payment_method_options: {
      us_bank_account: buildUsBankAccountCheckoutOptions()
    },
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: normalizedDescription,
            description: propertyAddress ? `Property: ${propertyAddress}` : undefined
          },
          unit_amount: Math.round(amount * 100)
        },
        quantity: 1
      }
    ],
    customer_email: tenantEmail || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: sanitizeStripeMetadata({
      description: normalizedDescription,
      propertyAddress: propertyAddress || '',
      ...metadata
    }),
    ...(paymentIntentData
      ? {
          payment_intent_data: {
            ...paymentIntentData,
            metadata: sanitizeStripeMetadata(paymentIntentData.metadata || {})
          }
        }
      : {})
  };
}

export function buildTenantAutopaySetupSessionParams({
  customerId,
  successUrl,
  cancelUrl,
  setupIntentMetadata = {},
  metadata = {}
}) {
  return {
    mode: 'setup',
    payment_method_types: ['us_bank_account'],
    payment_method_options: {
      us_bank_account: buildUsBankAccountCheckoutOptions()
    },
    customer: customerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    setup_intent_data: {
      metadata: sanitizeStripeMetadata(setupIntentMetadata)
    },
    metadata: sanitizeStripeMetadata(metadata)
  };
}

export function buildTenantAutopaySubscriptionParams({
  customerId,
  priceId,
  paymentMethodId,
  billingAnchorTimestamp,
  accountId,
  metadata = {}
}) {
  return {
    customer: customerId,
    items: [{ price: priceId }],
    default_payment_method: paymentMethodId,
    collection_method: 'charge_automatically',
    payment_settings: {
      payment_method_types: ['us_bank_account'],
      save_default_payment_method: 'on_subscription'
    },
    billing_cycle_anchor: billingAnchorTimestamp,
    proration_behavior: 'none',
    transfer_data: {
      destination: accountId
    },
    application_fee_percent: 2,
    metadata: sanitizeStripeMetadata(metadata)
  };
}

function asExpandedStripeObject(value) {
  return value && typeof value === 'object' ? value : null;
}

export function deriveStripePaymentMethodTypeFromPaymentIntent(paymentIntent) {
  const expandedPaymentIntent = asExpandedStripeObject(paymentIntent);
  if (!expandedPaymentIntent) {
    return null;
  }

  const expandedPaymentMethod = asExpandedStripeObject(expandedPaymentIntent.payment_method);
  if (expandedPaymentMethod?.type) {
    return expandedPaymentMethod.type;
  }

  const expandedLatestCharge = asExpandedStripeObject(expandedPaymentIntent.latest_charge);
  const chargeType = expandedLatestCharge?.payment_method_details?.type;
  if (chargeType) {
    return chargeType;
  }

  if (
    Array.isArray(expandedPaymentIntent.payment_method_types)
    && expandedPaymentIntent.payment_method_types.length === 1
  ) {
    return expandedPaymentIntent.payment_method_types[0];
  }

  return null;
}

export function deriveStripePaymentMethodTypeFromCheckoutSession(session) {
  const expandedSession = asExpandedStripeObject(session);
  if (!expandedSession) {
    return null;
  }

  const paymentIntentType = deriveStripePaymentMethodTypeFromPaymentIntent(expandedSession.payment_intent);
  if (paymentIntentType) {
    return paymentIntentType;
  }

  if (Array.isArray(expandedSession.payment_method_types) && expandedSession.payment_method_types.length === 1) {
    return expandedSession.payment_method_types[0];
  }

  return null;
}