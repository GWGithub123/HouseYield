#!/bin/bash
# Reboot the H&T sensor for a clean deep-sleep cycle
# This ensures thresholds take effect properly
IP="172.20.10.11"

echo "Waiting for sensor at $IP... PRESS THE BUTTON NOW"

for i in $(seq 1 120); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/rpc/Sys.GetStatus" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "SENSOR AWAKE!"

    echo ""
    echo "=== Current temp (this becomes the baseline after reboot) ==="
    curl -s "http://$IP/rpc/Shelly.GetStatus" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=d.get('temperature:0',{})
h=d.get('humidity:0',{})
print('  Temp:', t.get('tC'), 'C /', t.get('tF'), 'F')
print('  Humidity:', h.get('rh'), '%')
"

    echo ""
    echo "=== Verifying thresholds ==="
    curl -s "http://$IP/rpc/Temperature.GetConfig?id=0" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  report_thr_C:', d.get('report_thr_C'))
"
    curl -s "http://$IP/rpc/Humidity.GetConfig?id=0" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  report_thr:', d.get('report_thr'))
"

    echo ""
    echo "=== Verifying webhooks ==="
    curl -s "http://$IP/rpc/Webhook.List" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for h in d.get('hooks',[]):
    enabled = 'ON' if h.get('enable') else 'OFF'
    print(f'  [{enabled}] {h.get(\"event\")} -> {h.get(\"name\")}')
"

    echo ""
    echo "=== Rebooting sensor ==="
    curl -s "http://$IP/rpc/Shelly.Reboot"
    echo ""
    echo ""
    echo "REBOOTED! The sensor will:"
    echo "  1. Wake up fresh"
    echo "  2. Take a baseline temperature reading"
    echo "  3. Go to deep sleep"
    echo "  4. Internally measure every ~60s while sleeping"
    echo "  5. If temp changes >= 0.5C from baseline -> wake WiFi + fire webhook"
    echo ""
    echo "Wait ~30 seconds for it to fully sleep, then put it by the heater."
    echo "Watch logs with: npx firebase functions:log --only shellyWebhook"
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond in 120s. Try pressing the button."
exit 1
