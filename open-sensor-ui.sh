#!/bin/bash
IP="172.20.10.11"
echo "PRESS THE SENSOR BUTTON NOW"
echo ""

for i in $(seq 1 60); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/" 2>/dev/null)
  if [ "$CODE" = "200" ] || [ "$CODE" = "302" ]; then
    echo ""
    echo "========================================"
    echo "SENSOR AWAKE!"
    echo "========================================"
    echo ""
    echo "Open this URL in your browser RIGHT NOW:"
    echo ""
    echo "  http://$IP"
    echo ""
    echo "Check these sections:"
    echo "  1. Webhooks/Actions - verify our webhooks are there"
    echo "  2. Sensor Settings - verify thresholds"  
    echo "  3. Settings - try firmware update from the UI"
    echo ""
    echo "The sensor will go back to sleep in ~30-60 seconds!"
    echo ""
    echo "Keeping sensor alive by polling..."
    
    for j in $(seq 1 120); do
      curl -s --connect-timeout 1 "http://$IP/rpc/Sys.GetStatus" > /dev/null 2>&1
      sleep 1
    done
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond."
exit 1
