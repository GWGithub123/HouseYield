#!/bin/bash
IP="172.20.10.11"
echo "PRESS THE BUTTON NOW"

for i in $(seq 1 120); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/rpc/Sys.GetStatus" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "SENSOR AWAKE!"

    echo ""
    echo "--- Step 1: Check for updates ---"
    CHECK=$(curl -s -X POST -H "Content-Type: application/json" -d '{}' "http://$IP/rpc/Shelly.CheckForUpdate")
    echo "  $CHECK"

    echo ""
    echo "--- Step 2: Waiting 5 seconds for update info to load ---"
    sleep 5

    echo ""
    echo "--- Step 3: Applying update ---"
    RESULT=$(curl -s -X POST -H "Content-Type: application/json" -d '{"stage":"stable"}' "http://$IP/rpc/Shelly.Update")
    echo "  $RESULT"

    if echo "$RESULT" | grep -q "error\|code"; then
      echo ""
      echo "Direct update failed. Trying OTA with explicit URL..."
      # Try direct OTA URL for HTG3
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"url":"https://archive.shelly-tools.de/version/v1.7.4/ShellyHTG3.zip"}' \
        "http://$IP/rpc/Shelly.Update"
      echo ""
      
      echo "Trying official Shelly OTA endpoint..."
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"url":"http://rounder-update.shelly.cloud/firmware/HTG3/1.7.4/HTG3-1.7.4.zip"}' \
        "http://$IP/rpc/Shelly.Update"
      echo ""
    fi

    echo ""
    echo "Monitoring for reboot..."
    for j in $(seq 1 60); do
      sleep 2
      VER=$(curl -s --connect-timeout 1 "http://$IP/rpc/Shelly.GetDeviceInfo" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('ver',''))" 2>/dev/null)
      if [ -n "$VER" ] && [ "$VER" != "1.4.5" ]; then
        echo ""
        echo "UPDATED TO: $VER"
        exit 0
      fi
      printf "."
    done
    
    echo ""
    echo "Still on 1.4.5. May need to update via Shelly app."
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond."
exit 1
