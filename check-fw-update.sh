#!/bin/bash
# Poll gateway firmware version until update completes
GW_IP="172.20.10.9"
echo "Polling gateway firmware version..."
for i in $(seq 1 10); do
  sleep 10
  VER=$(curl -s --connect-timeout 3 "http://${GW_IP}/rpc/Shelly.GetDeviceInfo" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('ver','UNREACHABLE'))" 2>/dev/null || echo "UNREACHABLE")
  echo "Check $i: FW=$VER"
  if [ "$VER" != "1.0.99-blugwprod1bledev" ] && [ "$VER" != "UNREACHABLE" ]; then
    echo "UPDATE COMPLETE!"
    exit 0
  fi
  if [ "$VER" = "UNREACHABLE" ]; then
    echo "  (gateway may be rebooting)"
  fi
done
echo "Update may still be in progress. Try again."
