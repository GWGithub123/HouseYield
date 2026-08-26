#!/bin/bash
# Quick check - wake sensor with button press and verify current readings + thresholds
IP="172.20.10.11"

echo "Waiting for sensor at $IP... PRESS THE BUTTON ON THE SENSOR NOW"
echo "(This will check current temp to see if heater is registering)"

for i in $(seq 1 120); do
  CODE=$(curl -s --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://$IP/rpc/Sys.GetStatus" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "SENSOR AWAKE!"
    
    echo ""
    echo "=== Current Readings ==="
    curl -s "http://$IP/rpc/Shelly.GetStatus" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=d.get('temperature:0',{})
h=d.get('humidity:0',{})
dp=d.get('devicepower:0',{})
s=d.get('sys',{})
wr=s.get('wakeup_reason',{})
print('  Temp:', t.get('tC'), 'C /', t.get('tF'), 'F')
print('  Humidity:', h.get('rh'), '%')
print('  Battery:', dp.get('battery',{}).get('percent'), '%  Voltage:', dp.get('battery',{}).get('V'), 'V')
print('  Wakeup period:', s.get('wakeup_period'), 's')
print('  Wakeup reason:', wr.get('boot'), '/', wr.get('cause'))
print('  Uptime:', s.get('uptime'), 's')
"

    echo ""
    echo "=== Temperature Config (check report_thr_C) ==="
    curl -s "http://$IP/rpc/Temperature.GetConfig?id=0" | python3 -m json.tool

    echo ""
    echo "=== Humidity Config (check report_thr) ==="
    curl -s "http://$IP/rpc/Humidity.GetConfig?id=0" | python3 -m json.tool

    echo ""
    echo "=== Current Webhooks ==="
    curl -s "http://$IP/rpc/Webhook.List" | python3 -c "
import sys,json
d=json.load(sys.stdin)
hooks=d.get('hooks',[])
if not hooks:
    print('  No webhooks configured!')
else:
    for h in hooks:
        enabled = '✅' if h.get('enable') else '❌'
        print(f'  {enabled} [{h.get(\"id\")}] {h.get(\"event\")} -> {h.get(\"name\",\"\")}')
        for u in h.get('urls',[]):
            print(f'      URL: {u[:120]}...' if len(u)>120 else f'      URL: {u}')
"

    echo ""
    echo "=== Supported Webhook Events ==="
    curl -s "http://$IP/rpc/Webhook.ListSupported" | python3 -c "
import sys,json
d=json.load(sys.stdin)
types=d.get('types',{})
for event_name in sorted(types.keys()):
    attrs=types[event_name].get('attrs',[])
    attr_names=', '.join(a.get('name','') for a in attrs)
    print(f'  {event_name}' + (f'  (attrs: {attr_names})' if attr_names else ''))
"

    echo ""
    echo "DONE! Now put it back by the heater."
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond in 120s."
exit 1
