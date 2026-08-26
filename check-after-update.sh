#!/bin/bash
IP="172.20.10.11"
echo "Waiting for sensor to come back after firmware update..."
echo "(If it went to sleep, press the button)"

for i in $(seq 1 120); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/rpc/Shelly.GetDeviceInfo" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "SENSOR BACK ONLINE!"
    
    echo ""
    echo "=== Device Info ==="
    curl -s "http://$IP/rpc/Shelly.GetDeviceInfo" | python3 -m json.tool

    echo ""
    echo "=== Current Readings ==="
    curl -s "http://$IP/rpc/Shelly.GetStatus" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=d.get('temperature:0',{})
h=d.get('humidity:0',{})
s=d.get('sys',{})
print('  Temp:', t.get('tC'), 'C /', t.get('tF'), 'F')
print('  Humidity:', h.get('rh'), '%')
print('  Available updates:', s.get('available_updates',{}))
print('  Wakeup period:', s.get('wakeup_period'), 's')
print('  Wakeup reason:', s.get('wakeup_reason'))
"

    echo ""
    echo "=== Sleep Config ==="
    curl -s "http://$IP/rpc/Sys.GetConfig" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(json.dumps(d.get('sleep',{}), indent=2))
"

    echo ""
    echo "=== Webhooks ==="
    curl -s "http://$IP/rpc/Webhook.List" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for h in d.get('hooks',[]):
    print('  ID', h['id'], ':', h['event'], 'enabled=' + str(h['enable']))
"

    echo ""
    echo "=== Thresholds ==="
    curl -s -X POST -H "Content-Type: application/json" -d '{"id":0}' "http://$IP/rpc/Temperature.GetConfig" | python3 -m json.tool
    curl -s -X POST -H "Content-Type: application/json" -d '{"id":0}' "http://$IP/rpc/Humidity.GetConfig" | python3 -m json.tool

    exit 0
  fi
  printf "."
  sleep 2
done

echo ""
echo "Sensor did not respond. Press the button to wake it."
exit 1
