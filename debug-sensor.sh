#!/bin/bash
# Debug sensor WiFi and sleep behavior
IP="172.20.10.11"

echo "Waiting for sensor at $IP... PRESS THE BUTTON NOW"

for i in $(seq 1 120); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/rpc/Sys.GetStatus" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "SENSOR AWAKE!"

    echo ""
    echo "=== Full System Status ==="
    curl -s "http://$IP/rpc/Shelly.GetStatus" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(json.dumps(d, indent=2))
"

    echo ""
    echo "=== WiFi Status ==="
    curl -s "http://$IP/rpc/WiFi.GetStatus" | python3 -m json.tool

    echo ""
    echo "=== WiFi Config ==="
    curl -s "http://$IP/rpc/WiFi.GetConfig" | python3 -m json.tool

    echo ""
    echo "=== System Config (sleep settings) ==="
    curl -s "http://$IP/rpc/Sys.GetConfig" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(json.dumps(d.get('sleep',{}), indent=2))
print('Device name:', d.get('device',{}).get('name'))
"

    echo ""
    echo "=== Cloud Status ==="
    curl -s "http://$IP/rpc/Cloud.GetStatus" | python3 -m json.tool

    echo ""
    echo "=== Debug Info ==="
    curl -s "http://$IP/rpc/Shelly.GetDeviceInfo" | python3 -m json.tool

    echo ""
    echo "=== Checking for any system errors ==="
    curl -s "http://$IP/rpc/Sys.GetStatus" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  Uptime:', d.get('uptime'), 's')
print('  RAM free:', d.get('ram_free'))
print('  Wakeup reason:', d.get('wakeup_reason', {}).get('boot', 'unknown'))
print('  Wakeup period:', d.get('wakeup_period'), 's')
for k,v in d.items():
    if 'error' in str(k).lower() or 'error' in str(v).lower():
        print(f'  ERROR: {k} = {v}')
"

    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond in 120s."
exit 1
