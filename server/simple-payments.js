/**
 * Simple Stripe Payment Integration (No Connect Required)
 * Direct payment processing for landlord-tenant rent payments
 */

import express from 'express';
import Stripe from 'stripe';

const router = express.Router();

// Simple rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 5; // 5 requests per minute

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }
  
  const requests = requestCounts.get(ip).filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (requests.length >= MAX_REQUESTS) {
    return res.status(429).json({
      ok: false,
      error: 'Too many requests. Please wait a moment before trying again.'
    });
  }
  
  requests.push(now);
  requestCounts.set(ip, requests);
  next();
};

// Initialize Stripe with your secret key
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-11-20.acacia'
});

console.log('[Simple Payments] Initialized with Stripe');

/**
 * POST /api/payments/create-checkout
 * Create a simple checkout session for rent payment
 */
router.post('/create-checkout', async (req, res) => {
  try {
    const { tenantName, tenantEmail, amount, propertyAddress, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Valid amount is required' 
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'us_bank_account'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: description || 'Rent Payment',
              description: propertyAddress ? `Property: ${propertyAddress}` : undefined
            },
            unit_amount: Math.round(amount * 100) // Convert to cents
          },
          quantity: 1
        }
      ],
      customer_email: tenantEmail,
      success_url: 'http://localhost:5173/payment-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'http://localhost:5173/portfolio?payment=cancelled',
      metadata: {
        tenantName: tenantName || '',
        tenantEmail: tenantEmail || '',
        propertyAddress: propertyAddress || '',
        paymentType: 'rent'
      }
    });

    res.json({
      ok: true,
      url: session.url,
      sessionId: session.id
    });

    console.log('[Simple Payments] Created checkout session:', session.id);
  } catch (error) {
    console.error('[Simple Payments] Error creating checkout:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/payments/status/:sessionId
 * Get payment status
 */
router.get('/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    res.json({
      ok: true,
      status: session.payment_status,
      amountTotal: session.amount_total / 100,
      customerEmail: session.customer_email,
      metadata: session.metadata
    });
  } catch (error) {
    console.error('[Simple Payments] Error fetching status:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

export default router;
