#!/bin/bash

# Test script for AI Maintenance Voice Call Automation
# This script demonstrates the complete workflow

echo "╔════════════════════════════════════════════════════════════════════════════╗"
echo "║           AI MAINTENANCE VOICE CALL - COMPLETE TEST WORKFLOW               ║"
echo "╚════════════════════════════════════════════════════════════════════════════╝"
echo ""

SERVER_URL="http://localhost:3001"

# Step 1: Analyze a test email
echo "📧 STEP 1: Analyzing a test tenant email..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

ANALYSIS_RESPONSE=$(curl -s -X POST "$SERVER_URL/api/tenant-emails/analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "emailContent": "Hi, the kitchen sink is leaking badly under the cabinet. Water is pooling on the floor. I need this fixed ASAP! I am available weekdays after 5pm or any time on weekends. My phone is 555-123-4567. Unit 2B at 123 Main St, Potomac, MD 20854",
    "subject": "URGENT: Kitchen sink leaking",
    "from": "tenant@example.com"
  }')

echo "$ANALYSIS_RESPONSE" | jq '.'
echo ""

# Extract the issue details
ISSUE=$(echo "$ANALYSIS_RESPONSE" | jq -r '.issue')
URGENCY=$(echo "$ANALYSIS_RESPONSE" | jq -r '.urgency')
AVAILABILITY=$(echo "$ANALYSIS_RESPONSE" | jq -r '.tenantAvailability')
ADDRESS=$(echo "$ANALYSIS_RESPONSE" | jq -r '.propertyAddress')

echo "✅ Email Analysis Complete!"
echo "   Issue: $ISSUE"
echo "   Urgency: $URGENCY"
echo "   Tenant Availability: $AVAILABILITY"
echo "   Property: $ADDRESS"
echo ""

# Step 2: Check email history
echo "📋 STEP 2: Checking processed email history..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

HISTORY_RESPONSE=$(curl -s "$SERVER_URL/api/tenant-emails/history?limit=1")
echo "$HISTORY_RESPONSE" | jq '.'
echo ""

# Step 3: Initiate voice call with context
echo "📞 STEP 3: Initiating AI voice call with maintenance context..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -p "Enter provider phone number (+1XXXXXXXXXX): " PHONE_NUMBER

if [ -z "$PHONE_NUMBER" ]; then
  echo "❌ No phone number provided. Using test number +15551234567"
  PHONE_NUMBER="+15551234567"
fi

echo ""
echo "Calling $PHONE_NUMBER with the following context:"
echo "  - Issue: $ISSUE"
echo "  - Urgency: $URGENCY"  
echo "  - Availability: $AVAILABILITY"
echo "  - Address: $ADDRESS"
echo ""

CALL_RESPONSE=$(curl -s -X POST "$SERVER_URL/api/voice/call" \
  -H "Content-Type: application/json" \
  -d "{
    \"to\": \"$PHONE_NUMBER\",
    \"maintenanceContext\": {
      \"issue\": \"$ISSUE\",
      \"urgency\": \"$URGENCY\",
      \"location\": \"kitchen\",
      \"serviceCategory\": \"plumbing\",
      \"tenantAvailability\": \"$AVAILABILITY\",
      \"propertyAddress\": \"$ADDRESS\",
      \"unitNumber\": \"2B\",
      \"tenantEmail\": \"tenant@example.com\",
      \"tenantPhone\": \"555-123-4567\"
    }
  }")

echo "$CALL_RESPONSE" | jq '.'
echo ""

CALL_SID=$(echo "$CALL_RESPONSE" | jq -r '.callSid')

if [ "$CALL_SID" != "null" ]; then
  echo "✅ Call initiated successfully!"
  echo "   Call SID: $CALL_SID"
  echo ""
  echo "🎙️  The AI will:"
  echo "   1. Introduce as the property manager"
  echo "   2. Explain: '$ISSUE'"
  echo "   3. State urgency: $URGENCY"
  echo "   4. Communicate tenant availability: '$AVAILABILITY'"
  echo "   5. Schedule the appointment"
  echo "   6. Confirm all details"
else
  echo "❌ Call failed!"
  ERROR=$(echo "$CALL_RESPONSE" | jq -r '.error')
  echo "   Error: $ERROR"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════════════════╗"
echo "║                              TEST COMPLETE                                  ║"
echo "╚════════════════════════════════════════════════════════════════════════════╝"
