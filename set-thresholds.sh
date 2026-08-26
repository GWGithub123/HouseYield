#!/bin/bash
# Quick script to just set lower thresholds on the H&T sensor
# Press the button on the sensor FIRST, then run this script
IP="172.20.10.11"

echo "Waiting for sensor at $IP... PRESS THE BUTTON NOW"

for i in $(seq 1 120); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/rpc/Sys.GetStatus" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "SENSOR AWAKE!"

    echo ""
    echo "--- Current readings ---"
    curl -s "http://$IP/rpc/Shelly.GetStatus" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=d.get('temperature:0',{})
h=d.get('humidity:0',{})
print('  Temp:', t.get('tC'), 'C /', t.get('tF'), 'F')
print('  Humidity:', h.get('rh'), '%')
"

    echo ""
    echo "--- Current Temperature config ---"
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"id":0}' \
      "http://$IP/rpc/Temperature.GetConfig" | python3 -m json.tool

    echo ""
    echo "--- Current Humidity config ---"
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"id":0}' \
      "http://$IP/rpc/Humidity.GetConfig" | python3 -m json.tool

    echo ""
    echo "--- Setting temperature threshold to 0.5°C (firmware minimum) ---"
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"id":0,"config":{"report_thr_C":0.5}}' \
      "http://$IP/rpc/Temperature.SetConfig" | python3 -m json.tool

    echo ""
    echo "--- Setting humidity threshold to 1.0% (firmware minimum) ---"
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"id":0,"config":{"report_thr":1.0}}' \
      "http://$IP/rpc/Humidity.SetConfig" | python3 -m json.tool

    echo ""
    echo "--- Verifying Temperature config ---"
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"id":0}' \
      "http://$IP/rpc/Temperature.GetConfig" | python3 -m json.tool

    echo ""
    echo "--- Verifying Humidity config ---"
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"id":0}' \
      "http://$IP/rpc/Humidity.GetConfig" | python3 -m json.tool

    echo ""
    echo "--- Verifying webhooks still exist ---"
    curl -s "http://$IP/rpc/Webhook.List" | python3 -m json.tool

    echo ""
    echo "DONE! Thresholds set to 0.1°C temp / 0.25% humidity"
    echo "Put it back by the heater — should fire within ~60 seconds of any tiny change."
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond in 120s. Try pressing the button."
exit 1
