#!/bin/bash
# Test the complete Shelly sensor pipeline
# Device → Firebase Cloud Function → Firestore → Frontend

WEBHOOK_URL="${SHELLY_WEBHOOK_URL:-${SHELLY_FIREBASE_WEBHOOK_URL:-https://houseyield-backend-rhrpiopisa-uc.a.run.app/api/shelly/webhook}}"
DEVICE_ID="shellyfloodg4-48f6eed3c830"

echo "🧪 Testing Shelly Sensor Pipeline"
echo "=================================="
echo ""

echo "📝 Step 1: Send normal status (no flood)"
curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "src": "'$DEVICE_ID'",
    "method": "NotifyStatus",
    "params": {
      "ts": '$(date +%s)',
      "flood:0": { "alarm": false },
      "devicepower:0": { "battery": { "V": 5.8, "percent": 89 } },
      "wifi": { "rssi": -15 }
    }
  }' 2>&1
echo -e "\n"

sleep 2

echo "🚨 Step 2: Trigger FLOOD ALERT"
curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "src": "'$DEVICE_ID'",
    "method": "NotifyStatus",
    "params": {
      "ts": '$(date +%s)',
      "flood:0": { "alarm": true },
      "devicepower:0": { "battery": { "V": 5.8, "percent": 89 } },
      "wifi": { "rssi": -15 }
    }
  }' 2>&1
echo -e "\n"

sleep 2

echo "✅ Step 3: Clear flood alert"
curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "src": "'$DEVICE_ID'",
    "method": "NotifyStatus",
    "params": {
      "ts": '$(date +%s)',
      "flood:0": { "alarm": false },
      "devicepower:0": { "battery": { "V": 5.8, "percent": 89 } },
      "wifi": { "rssi": -15 }
    }
  }' 2>&1
echo -e "\n"

echo ""
echo "🎯 Pipeline test complete!"
echo ""
echo "Expected flow:"
echo "  1. ✅ Normal status → Device shows online, no flood"
echo "  2. 🚨 Flood triggered → Alert created in Firestore"
echo "  3. 📱 Frontend receives real-time update → Alert displayed"
echo "  4. ✅ Flood cleared → Device status updated"
echo ""
echo "Check your browser console for:"
echo "  - '🔥 useShellyFirestore: Setting up Firestore subscriptions...'"
echo "  - '📱 Received X devices from Firestore'"
echo "  - '🚨 Received X alerts from Firestore'"
echo ""
echo "Check the Sensors/Alerts tabs in the dashboard to see the updates!"
