#!/bin/bash

# FRED API Key Setup Script
# This script helps you update your FRED API key

echo "🏦 FRED API Key Setup"
echo "===================="
echo ""
echo "Your current FRED API key is being rejected (403 Forbidden)."
echo ""
echo "To fix this:"
echo "1. Go to: https://fred.stlouisfed.org/docs/api/api_key.html"
echo "2. Click 'Request API Key' (it's free!)"
echo "3. Fill out the quick form"
echo "4. Copy your new API key"
echo "5. Run: echo 'FRED_API_KEY=YOUR_NEW_KEY' >> .env"
echo ""
echo "Or paste your new key now and press Enter:"
echo "(Leave blank to skip)"
echo ""
read -p "New FRED API Key: " new_key

if [ -z "$new_key" ]; then
  echo ""
  echo "❌ Skipped. Update .env manually when ready."
  exit 0
fi

# Backup .env
cp .env .env.backup

# Update FRED_API_KEY in .env
if grep -q "FRED_API_KEY=" .env; then
  # Replace existing key
  sed -i.bak "s/FRED_API_KEY=.*/FRED_API_KEY=$new_key/" .env
  rm .env.bak 2>/dev/null
  echo ""
  echo "✅ FRED API key updated!"
else
  # Add new key
  echo "FRED_API_KEY=$new_key" >> .env
  echo ""
  echo "✅ FRED API key added!"
fi

echo ""
echo "Backup saved to: .env.backup"
echo ""
echo "🚀 Now restart your dev server:"
echo "   npm run dev"
