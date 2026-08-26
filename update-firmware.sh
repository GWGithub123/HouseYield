#!/bin/bash
IP="172.20.10.11"
echo "PRESS THE BUTTON NOW — will update firmware immediately when sensor wakes"

for i in $(seq 1 120); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/rpc/Sys.GetStatus" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "SENSOR AWAKE! Triggering firmware update NOW..."
    
    # Trigger update
    RESULT=$(curl -s -X POST -H "Content-Type: application/json" -d '{"stage":"stable"}' "http://$IP/rpc/Shelly.Update")
    echo "  Update response: $RESULT"
    
    # Keep polling to keep connection alive and monitor progress
    echo ""
    echo "Monitoring update progress (this takes 1-3 minutes)..."
    echo "Keep the sensor close to your phone hotspot for good WiFi signal."
    
    for j in $(seq 1 90); do
      sleep 2
      # Try to get status - sensor will reboot during update
      STATUS=$(curl -s --connect-timeout 2 "http://$IP/rpc/Shelly.GetDeviceInfo" 2>/dev/null)
      if [ -n "$STATUS" ]; then
        VER=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ver','unknown'))" 2>/dev/null)
        if [ "$VER" != "1.4.5" ] && [ "$VER" != "unknown" ]; then
          echo ""
          echo "FIRMWARE UPDATED TO: $VER"
          echo "$STATUS" | python3 -m json.tool
          exit 0
        fi
        printf "v${VER}."
      else
        printf "."
      fi
    done
    
    echo ""
    echo "Update may still be in progress. Press button and run check-after-update.sh"
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond in 120s."
exit 1
