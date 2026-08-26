#!/bin/bash
# Script to update H&T sensor webhooks with template variables
# Uses ${ev.xxx} Shelly Gen2/Gen3 URL token replacement syntax
# Run this, then press the button on the sensor

SENSOR_IP="172.20.10.11"
FIREBASE_URL="${SHELLY_WEBHOOK_URL:-${SHELLY_FIREBASE_WEBHOOK_URL:-https://houseyield-backend-rhrpiopisa-uc.a.run.app/api/shelly/webhook}}"
DEVICE_ID="shellyhtg3-d0cf13c27f04"

# Use Shelly's ${ev.xxx} token replacement + cross-data from status object
TEMP_URL="${FIREBASE_URL}?device_id=${DEVICE_ID}&event=temperature.change&tC=\${ev.tC}&tF=\${ev.tF}&rh=\${status[\"humidity:0\"].rh}&battery=\${status[\"devicepower:0\"].battery.percent}"
HUM_URL="${FIREBASE_URL}?device_id=${DEVICE_ID}&event=humidity.change&rh=\${ev.rh}&tC=\${status[\"temperature:0\"].tC}&tF=\${status[\"temperature:0\"].tF}&battery=\${status[\"devicepower:0\"].battery.percent}"

echo "⏳ Waiting for sensor to wake up... Press the button on the H&T sensor!"
echo ""

while true; do
  result=$(curl -s --connect-timeout 2 "http://${SENSOR_IP}/rpc/Webhook.Update" \
    -H "Content-Type: application/json" \
    -d "{\"id\":1,\"urls\":[\"${TEMP_URL}\"]}" 2>&1)
  
  if echo "$result" | grep -q "rev"; then
    echo "✅ Temperature webhook updated: $result"
    
    # Immediately update humidity webhook too
    result2=$(curl -s --connect-timeout 2 "http://${SENSOR_IP}/rpc/Webhook.Update" \
      -H "Content-Type: application/json" \
      -d "{\"id\":2,\"urls\":[\"${HUM_URL}\"]}" 2>&1)
    echo "✅ Humidity webhook updated: $result2"
    
    # Also verify and check wakeup_period
    status=$(curl -s --connect-timeout 2 "http://${SENSOR_IP}/rpc/Sys.GetStatus" 2>&1)
    echo ""
    echo "📊 Current status:"
    echo "$status" | python3 -m json.tool 2>/dev/null || echo "$status"
    
    # Verify webhooks
    hooks=$(curl -s --connect-timeout 2 "http://${SENSOR_IP}/rpc/Webhook.List" 2>&1)
    echo ""
    echo "🔗 Webhooks:"
    echo "$hooks" | python3 -m json.tool 2>/dev/null || echo "$hooks"
    
    break
  fi
  
  sleep 0.3
done

echo ""
echo "✅ Done! Sensor will now send data with actual temperature/humidity values."
