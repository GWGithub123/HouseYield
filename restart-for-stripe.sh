#!/bin/bash

# Quick Restart Script for Stripe Integration
# This restarts the dev server to pick up the new Stripe endpoint

echo "🔄 Restarting development server to load Stripe integration..."
echo ""
echo "Please follow these steps:"
echo ""
echo "1. In your terminal running 'npm run dev', press Ctrl+C to stop it"
echo "2. Wait for it to fully stop"
echo "3. Run: npm run dev"
echo "4. Wait for both the frontend and backend to start"
echo "5. Refresh your browser (http://localhost:5173)"
echo "6. Try the payment modal again"
echo ""
echo "✅ The server will now have the /api/tenant-payment/create-checkout endpoint!"
echo ""
echo "To test:"
echo "  - Go to Portfolio → Tenant Payments"
echo "  - Click 'Record Payment'"
echo "  - Click 'Pay with Stripe'"
echo "  - You should be redirected to Stripe (no 404 error)"
echo ""
