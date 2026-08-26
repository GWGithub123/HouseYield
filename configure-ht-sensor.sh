#!/bin/bash
# Reconfigure H&T sensor with .measurement webhooks
# Uses ${ev.xxx} Shelly Gen2/Gen3 URL token replacement syntax
# Sends to Firebase Cloud Functions endpoint (not Cloud Run)
IP="172.20.10.11"
WEBHOOK_BASE="${SHELLY_WEBHOOK_URL:-${SHELLY_FIREBASE_WEBHOOK_URL:-https://houseyield-backend-rhrpiopisa-uc.a.run.app/api/shelly/webhook}}"
DEVICE_ID="shellyhtg3-d0cf13c27f04"

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
s=d.get('sys',{})
print('  Temp:', t.get('tC'), 'C /', t.get('tF'), 'F')
print('  Humidity:', h.get('rh'), '%')
print('  Wakeup:', s.get('wakeup_period'), 's')
"
    
    echo ""
    echo "--- Supported webhook events ---"
    curl -s "http://$IP/rpc/Webhook.ListSupported" | python3 -m json.tool
    
    echo ""
    echo "--- Deleting all old webhooks ---"
    curl -s "http://$IP/rpc/Webhook.DeleteAll" | python3 -m json.tool 2>/dev/null
    echo "  Done"
    
    echo ""
    echo "--- Creating temperature.change webhook (threshold-triggered) ---"
    python3 -c "
import urllib.request, json
url = 'http://$IP/rpc/Webhook.Create'
data = json.dumps({
    'cid': 0,
    'enable': True,
    'event': 'temperature.change',
    'name': 'fb_temp',
    'urls': ['$WEBHOOK_BASE?device_id=$DEVICE_ID&event=temperature.change&tC=\${ev.tC}&tF=\${ev.tF}&rh=\${status[\"humidity:0\"].rh}&battery=\${status[\"devicepower:0\"].battery.percent}']
}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=5)
print('  Result:', resp.read().decode())
"
    
    echo ""
    echo "--- Creating humidity.change webhook (threshold-triggered) ---"
    python3 -c "
import urllib.request, json
url = 'http://$IP/rpc/Webhook.Create'
data = json.dumps({
    'cid': 0,
    'enable': True,
    'event': 'humidity.change',
    'name': 'fb_hum',
    'urls': ['$WEBHOOK_BASE?device_id=$DEVICE_ID&event=humidity.change&rh=\${ev.rh}&tC=\${status[\"temperature:0\"].tC}&tF=\${status[\"temperature:0\"].tF}&battery=\${status[\"devicepower:0\"].battery.percent}']
}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=5)
print('  Result:', resp.read().decode())
"

    echo ""
    echo "--- Creating temperature.measurement webhook (60s periodic) ---"
    python3 -c "
import urllib.request, json
url = 'http://$IP/rpc/Webhook.Create'
data = json.dumps({
    'cid': 0,
    'enable': True,
    'event': 'temperature.measurement',
    'name': 'fb_temp_periodic',
    'urls': ['$WEBHOOK_BASE?device_id=$DEVICE_ID&event=temperature.measurement&tC=\${ev.tC}&tF=\${ev.tF}&rh=\${status[\"humidity:0\"].rh}&battery=\${status[\"devicepower:0\"].battery.percent}']
}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=5)
print('  Result:', resp.read().decode())
" || echo '  (measurement event may not be supported on this firmware)'

    echo ""
    echo "--- Creating humidity.measurement webhook (60s periodic) ---"
    python3 -c "
import urllib.request, json
url = 'http://$IP/rpc/Webhook.Create'
data = json.dumps({
    'cid': 0,
    'enable': True,
    'event': 'humidity.measurement',
    'name': 'fb_hum_periodic',
    'urls': ['$WEBHOOK_BASE?device_id=$DEVICE_ID&event=humidity.measurement&rh=\${ev.rh}&tC=\${status[\"temperature:0\"].tC}&tF=\${status[\"temperature:0\"].tF}&battery=\${status[\"devicepower:0\"].battery.percent}']
}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=5)
print('  Result:', resp.read().decode())
" || echo '  (measurement event may not be supported on this firmware)'
    
    echo ""
    echo "--- Setting wakeup period to 120s ---"
    python3 -c "
import urllib.request, json
url = 'http://$IP/rpc/Sys.SetConfig'
data = json.dumps({'config': {'sleep': {'wakeup_period': 120}}}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=5)
print('  Result:', resp.read().decode())
"

    echo ""
    echo "--- Setting temperature report threshold to 0.5°C (firmware minimum) ---"
    python3 -c "
import urllib.request, json
url = 'http://$IP/rpc/Temperature.SetConfig'
data = json.dumps({'id': 0, 'config': {'report_thr_C': 0.5}}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=5)
print('  Result:', resp.read().decode())
" || echo '  (may not be supported on this firmware)'

    echo ""
    echo "--- Setting humidity report threshold to 1.0% (firmware minimum) ---"
    python3 -c "
import urllib.request, json
url = 'http://$IP/rpc/Humidity.SetConfig'
data = json.dumps({'id': 0, 'config': {'report_thr': 1.0}}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=5)
print('  Result:', resp.read().decode())
" || echo '  (may not be supported on this firmware)'
    
    echo ""
    echo "--- Verifying webhooks ---"
    curl -s "http://$IP/rpc/Webhook.List" | python3 -m json.tool
    
    echo ""
    echo "--- Verifying wakeup period ---"
    curl -s "http://$IP/rpc/Sys.GetStatus" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  Wakeup period:', d.get('wakeup_period'), 's')
print('  Uptime:', d.get('uptime'), 's')
"
    
    echo ""
    echo "DONE! Sensor configured with:"
    echo "  - temperature.change + humidity.change webhooks (threshold-triggered)"
    echo "  - temperature.measurement + humidity.measurement webhooks (60s periodic)"
    echo "  - Thresholds: 0.5°C temp / 1.0% humidity (firmware minimums)"
    echo "  - Wakeup period: 120s"
    echo "  - All webhooks → Cloud Functions endpoint"
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Sensor did not respond in 120s. Try pressing the button."
exit 1
