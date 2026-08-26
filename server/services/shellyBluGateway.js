/**
 * Shelly BLU Gateway Integration Service
 * 
 * Manages the Shelly BLU Gateway which acts as a Bluetooth-to-WiFi 
 * bridge for Shelly BLE devices (H&T Gen3, Flood sensors, etc.)
 * 
 * Uses the Script API to push a BLE scanner script to the gateway.
 * The script passively listens for BTHome BLE advertisements and
 * HTTP POSTs parsed sensor data to our server. This approach:
 *   - Works on ALL gateway firmware versions (no BTHome.* RPC needed)
 *   - Is plug-and-play (script auto-deployed on gateway setup)
 *   - Requires no pairing — BLE sensors just broadcast
 * 
 * Architecture:
 *   BLE Sensors (broadcast BTHome) → BLU Gateway Script (BLE.Scanner)
 *     → HTTP POST → Our Server → Firestore → Frontend
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import os from 'os';
import { resolveShellyWebhookUrl } from '../utils/iotProjectConfig.js';

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function parseUrlOrNull(value) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

function getShellyFirebaseWebhookUrl() {
  return resolveShellyWebhookUrl();
}

function getShellyPublicBaseUrl() {
  const candidates = [
    process.env.SHELLY_SERVER_PUBLIC_URL,
    process.env.CLOUDFLARE_TUNNEL_URL,
    process.env.NGROK_URL,
    process.env.PUBLIC_URL,
  ];

  for (const candidate of candidates) {
    const parsed = parseUrlOrNull(candidate);
    if (parsed && !LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
      return parsed;
    }
  }

  return null;
}

// ─── The BLE Scanner Script ──────────────────────────────────────────────
// This JavaScript runs ON the Shelly BLU Gateway via the Script API.
// Based on the official Shelly BLE examples from:
//   https://github.com/ALLTERCO/shelly-script-examples/blob/main/ble/ble-shelly-blu.shelly.js
//
// The script:
//   1. Starts BLE.Scanner in passive infinite scan mode
//   2. Listens for BTHome v2 service data (UUID 0xFCD2) in BLE advertisements
//   3. Decodes BTHome payload into human-readable sensor data
//   4. HTTP POSTs the decoded data to our server endpoint
//   5. De-duplicates packets using BTHome packet ID
//
// SERVER_URL placeholder is replaced at deploy time with the actual URL.
// ─────────────────────────────────────────────────────────────────────────
function generateBLEScannerScript(serverUrl, cloudWebhookUrl) {
  // NOTE: This code runs inside the Shelly gateway's JS engine (Espruino-based).
  // Keep it compact — gateway has limited memory.
  //
  // v3.2: Cloud Run webhook is PRIMARY (always-on history). Local Node is
  // optional secondary only. Retries + longer timeout survive Cloud Run cold starts
  // so charts keep filling when the laptop/dev server is off.
  const fbUrl = cloudWebhookUrl || '';
  return `// HouseYield BLE Sensor Scanner v3.2 — Cloud Run primary, always-on
let SERVER="${serverUrl}";
let FBURL="${fbUrl}";
let COLLECTOR="houseyield-ble-v3.2";
let BTHOME="fcd2";
let U8=0;let I8=1;let U16=2;let I16=3;let U24=4;let I24=5;
let BTH={
0x00:{n:"pid",t:U8},
0x01:{n:"battery",t:U8},
0x02:{n:"temperature",t:I16,f:0.01},
0x03:{n:"humidity",t:U16,f:0.01},
0x05:{n:"illuminance",t:U24,f:0.01},
0x0c:{n:"voltage",t:U16,f:0.001},
0x14:{n:"moisture",t:U16,f:0.01},
0x21:{n:"motion",t:U8},
0x2d:{n:"window",t:U8},
0x2e:{n:"humidity",t:U8},
0x2f:{n:"moisture",t:U8},
0x3a:{n:"button",t:U8},
0x3f:{n:"rotation",t:I16,f:0.1},
0x45:{n:"temperature",t:I16,f:0.1},
0x04:{n:"pressure",t:U24,f:0.01},
0x4a:{n:"voltage",t:U16,f:0.1},
0x15:{n:"battery_ok",t:U8},
0x06:{n:"weight",t:U16,f:0.01},
0x09:{n:"count",t:U8},
0x3d:{n:"count",t:U16},
0x60:{n:"channel",t:U8}
};
function bsz(t){if(t===U8||t===I8)return 1;if(t===U16||t===I16)return 2;if(t===U24||t===I24)return 3;return 255;}
let Dec={
utoi:function(n,b){let m=1<<(b-1);return n&m?n-(1<<b):n;},
u8:function(b){return b.at(0);},
i8:function(b){return this.utoi(this.u8(b),8);},
u16:function(b){return 0xffff&((b.at(1)<<8)|b.at(0));},
i16:function(b){return this.utoi(this.u16(b),16);},
u24:function(b){return(b.at(2)<<16)|(b.at(1)<<8)|b.at(0);},
i24:function(b){return this.utoi(this.u24(b),24);},
val:function(t,b){
if(t===U8)return this.u8(b);if(t===I8)return this.i8(b);
if(t===U16)return this.u16(b);if(t===I16)return this.i16(b);
if(t===U24)return this.u24(b);if(t===I24)return this.i24(b);
return null;
},
unpack:function(buf){
if(typeof buf!=="string"||buf.length===0)return null;
let r={};let d=buf.at(0);
r.enc=d&0x1?true:false;
r.v=d>>5;
if(r.v!==2)return null;
if(r.enc)return r;
buf=buf.slice(1);
let b,v;
while(buf.length>0){
b=BTH[buf.at(0)];
if(typeof b==="undefined"){buf=buf.slice(1);continue;}
buf=buf.slice(1);
v=this.val(b.t,buf);
if(v===null)break;
if(typeof b.f!=="undefined")v=v*b.f;
if(typeof r[b.n]==="undefined"){r[b.n]=v;}
else if(Array.isArray(r[b.n])){r[b.n].push(v);}
else{r[b.n]=[r[b.n],v];}
buf=buf.slice(bsz(b.t));
}
return r;
}
};
let lastPid={};
let lastPostMs={};
let POST_MS=60000;
let sendQ=[];
let sending=false;
let MAX_BUF=60;
function mkId(d){return d.addr?"blu-ht-"+d.addr.split(":").join("").toLowerCase():"unknown";}
function postData(d){
let addr=d.addr||"";
let now=Date.now();
let prev=lastPostMs[addr]||0;
if(addr&&now-prev<POST_MS)return;
if(addr)lastPostMs[addr]=now;
sendQ.push(d);
if(sendQ.length>MAX_BUF)sendQ.splice(0,sendQ.length-MAX_BUF);
if(!sending)flush();
}
function buildCloudUrl(d){
let id=mkId(d);
let url=FBURL+"?device_id="+id+"&event=temperature_humidity&source=ble_gateway&collector_version="+COLLECTOR;
if(typeof d.temperature!=="undefined")url+="&tC="+d.temperature+"&tF="+(d.temperature*9/5+32);
if(typeof d.humidity!=="undefined")url+="&rh="+d.humidity;
if(typeof d.battery!=="undefined")url+="&battery="+d.battery;
return url;
}
function buildCloudBody(d){
let id=mkId(d);
let p={};
if(typeof d.temperature!=="undefined")p.tC=d.temperature;
if(typeof d.humidity!=="undefined")p.rh=d.humidity;
if(typeof d.battery!=="undefined")p.battery=d.battery;
return JSON.stringify({device_id:id,event:"temperature_humidity",src:id,params:p,source:"ble_gateway",collectorVersion:COLLECTOR});
}
function sendToCloud(d,attempt,cb){
if(!FBURL||FBURL.length<10){if(cb)cb(false);return;}
let id=mkId(d);
let tries=typeof attempt==="number"?attempt:0;
Shelly.call("HTTP.POST",{url:buildCloudUrl(d),body:buildCloudBody(d),content_type:"application/json",timeout:20},
function(r,e){
if(e!==0){
print("Cloud POST err:",e,"try",tries+1);
if(tries<2){Timer.set(1500,false,function(){sendToCloud(d,tries+1,cb);});}
else{if(cb)cb(false);}
}else{print("Cloud OK:",id);if(cb)cb(true);}
});
}
function sendToLocal(d){
if(!SERVER||SERVER.length<10)return;
Shelly.call("HTTP.POST",{url:SERVER,body:JSON.stringify(d),content_type:"application/json",timeout:3},
function(r,e){
if(e!==0){print("Local offline — Cloud-only mode");}
else{print("Local OK");}
});
}
function flush(){
if(sendQ.length===0){sending=false;return;}
sending=true;
let d=sendQ.splice(0,1)[0];
sendToCloud(d,0,function(ok){
let localPayload={};
for(let k in d)localPayload[k]=d[k];
localPayload.firebaseWriteSucceeded=ok;
localPayload.source=ok?"ble_gateway":"ble_gateway_fallback";
localPayload.collectorVersion=COLLECTOR;
sendToLocal(localPayload);
Timer.set(200,false,flush);
});
}
function scanCB(ev,res){
if(ev!==BLE.Scanner.SCAN_RESULT)return;
if(typeof res.service_data==="undefined"||typeof res.service_data[BTHOME]==="undefined")return;
let parsed=Dec.unpack(res.service_data[BTHOME]);
if(parsed===null||parsed.enc)return;
let addr=res.addr;
let pid=parsed.pid;
if(typeof pid!=="undefined"&&lastPid[addr]===pid)return;
if(typeof pid!=="undefined")lastPid[addr]=pid;
parsed.addr=addr;
parsed.rssi=res.rssi;
parsed.name=res.local_name||"";
postData(parsed);
print("BLE:",addr,JSON.stringify(parsed));
}
function init(){
let c=Shelly.getComponentConfig("ble");
if(!c.enable){print("BLE disabled!");return;}
if(BLE.Scanner.isRunning()){
print("Scanner running, subscribing");
}else{
let s=BLE.Scanner.Start({duration_ms:BLE.Scanner.INFINITE_SCAN,active:false});
if(!s){print("Scan start failed");return;}
print("Scanner started");
}
BLE.Scanner.Subscribe(scanCB);
print("HouseYield BLE scanner v3.2 ready");
print("Primary (Cloud Run):",FBURL);
print("Secondary (local optional):",SERVER);
}
init();
`;
}

// Script name used to identify our script on the gateway
const SCRIPT_NAME = 'houseyield-ble-scanner';

class ShellyBluGateway extends EventEmitter {
  constructor() {
    super();
    this.gatewayIp = process.env.SHELLY_BLU_GATEWAY_IP || null;
    this.gatewayId = process.env.SHELLY_BLU_GATEWAY_ID || null;
    this.initialized = false;
    this.scriptDeployed = false;
    this.scriptId = null;
    this.discoveredDevices = new Map(); // BLE addr -> latest sensor data
    this._lastHistoryWriteAt = new Map(); // deviceId -> ms
    // Persist chart history at most once per minute per sensor (BLE ads are ~11s).
    this.historyWriteIntervalMs = Math.max(
      60_000,
      Number(process.env.BLE_HISTORY_WRITE_INTERVAL_MS || 60_000),
    );
    this.isDiscovering = false;
    this.rpcTimeout = 10000;
  }

  // ─── Initialize ──────────────────────────────────────────────────

  /**
   * Initialize the BLU Gateway connection.
   * Connects locally, enables BLE, and auto-deploys the scanner script.
   * Starts a heartbeat to keep Firestore lastSeen updated and retry on failure.
   */
  async initialize() {
    if (!this.gatewayIp && !this.gatewayId) {
      console.warn('⚠️  BLU Gateway not configured. Set SHELLY_BLU_GATEWAY_IP in .env');
      return false;
    }
    
    if (this.initialized && this._localConnected) return true;

    try {
      if (this.gatewayIp) {
        const info = await this.rpcCall('Shelly.GetDeviceInfo');
        console.log(`✅ BLU Gateway connected locally at ${this.gatewayIp}`);
        console.log(`   Model: ${info.model || 'Unknown'}, FW: ${info.fw_id || 'Unknown'}`);
        
        await this.ensureBleEnabled();
        this.initialized = true;
        this._localConnected = true;
        this.emit('gateway:connected', { ip: this.gatewayIp, info });

        // Update Firestore with online status
        this._updateFirestoreStatus('online').catch(() => {});

        // Auto-deploy / upgrade BLE scanner so Cloud Run stays the always-on writer
        try {
          const ensured = await this.ensureCloudPrimaryWebhook();
          if (!ensured.ok) {
            console.warn('⚠️  BLE Cloud webhook ensure skipped:', ensured.reason);
            await this.deployBLEScript();
          } else {
            console.log(`✅ BLE scanner Cloud-primary ensure: ${ensured.action}`);
          }
        } catch (scriptErr) {
          console.warn('⚠️  BLE scanner script deploy deferred:', scriptErr.message);
        }

        // Start heartbeat (keeps Firestore lastSeen fresh + retries on disconnect)
        this.startHeartbeat();

        return true;
      }
    } catch (error) {
      console.error(`❌ Failed to connect to BLU Gateway at ${this.gatewayIp}:`, error.message);
      this._localConnected = false;
    }

    if (this.gatewayId) {
      console.log('ℹ️  BLU Gateway ID known but no local IP — limited functionality');
      this.initialized = true;
      // Start heartbeat even when not locally connected — it will retry
      this.startHeartbeat();
      return true;
    }

    return false;
  }

  /**
   * Periodic heartbeat: pings the gateway, updates Firestore lastSeen,
   * and retries initialization if the gateway was previously unreachable.
   * Runs every 60 seconds.
   */
  startHeartbeat() {
    if (this._heartbeatTimer) return; // already running
    
    const HEARTBEAT_INTERVAL = 60_000; // 60s
    console.log('💓 BLU Gateway heartbeat started (every 60s)');

    this._heartbeatTimer = setInterval(async () => {
      if (!this.gatewayIp) return;

      try {
        await this.rpcCall('Shelly.GetDeviceInfo');
        
        // Gateway is reachable
        if (!this._localConnected) {
          // Was offline, now back — re-initialize fully
          console.log('🔄 BLU Gateway became reachable — re-initializing...');
          this._localConnected = false;
          this.initialized = false;
          await this.initialize();
          return;
        }

        // Update Firestore lastSeen so dashboard shows "Online"
        await this._updateFirestoreStatus('online');
      } catch (err) {
        if (this._localConnected) {
          console.warn('⚠️  BLU Gateway heartbeat failed — gateway unreachable');
          this._localConnected = false;
          this.emit('gateway:unreachable', { ip: this.gatewayIp });
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Update the gateway's lastSeen / status in Firestore so the dashboard
   * shows the correct online/offline badge.
   */
  async _updateFirestoreStatus(status = 'online') {
    try {
      const docId = this.gatewayId || `shellyblugw-${(this.gatewayIp || '').replace(/\./g, '')}`;
      if (!docId || status === 'offline') {
        // Never stamp offline from a LAN miss — BLE child traffic is the
        // authoritative liveness signal when this host is off the IoT subnet.
        return;
      }
      const { touchCloudDevicePresence } = await import('../iot-cloud-firestore.js');
      await touchCloudDevicePresence(docId, {
        type: 'ble_gateway',
        connectionType: 'wifi',
        localIp: this.gatewayIp,
        ip: this.gatewayIp,
        scriptDeployed: this.scriptDeployed,
      });
    } catch (err) {
      // Silently ignore — Firestore may not be available
    }
  }

  // ─── RPC Methods ─────────────────────────────────────────────────

  /**
   * Make an RPC call to the gateway's local HTTP API.
   * Uses GET /rpc/Method?param=value format per Shelly Gen2 docs.
   */
  async rpcCall(method, params = {}) {
    if (!this.gatewayIp) {
      throw new Error('Gateway IP not configured for local RPC');
    }

    try {
      const url = `http://${this.gatewayIp}/rpc/${method}`;
      const serializedParams = {};
      for (const [key, value] of Object.entries(params)) {
        serializedParams[key] = typeof value === 'object' ? JSON.stringify(value) : value;
      }
      const response = await axios.get(url, {
        params: serializedParams,
        timeout: this.rpcTimeout,
      });
      return response.data;
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        console.error(`🔌 Gateway at ${this.gatewayIp} is unreachable`);
        this.emit('gateway:unreachable', { ip: this.gatewayIp });
      }
      throw error;
    }
  }

  /**
   * POST-based RPC call for methods requiring request body.
   */
  async rpcPost(method, params = {}) {
    if (!this.gatewayIp) {
      throw new Error('Gateway IP not configured for local RPC');
    }

    const response = await axios.post(`http://${this.gatewayIp}/rpc`, {
      id: Date.now(),
      method,
      params,
    }, {
      timeout: this.rpcTimeout,
    });

    if (response.data.error) {
      throw new Error(`RPC Error: ${JSON.stringify(response.data.error)}`);
    }

    return response.data.result;
  }

  // ─── BLE Configuration ──────────────────────────────────────────

  /**
   * Ensure BLE + observer is enabled on the gateway.
   */
  async ensureBleEnabled() {
    try {
      const bleConfig = await this.rpcCall('BLE.GetConfig');
      
      if (!bleConfig.enable || !bleConfig.observer?.enable) {
        console.log('🔵 Enabling Bluetooth + observer on BLU Gateway...');
        await this.rpcCall('BLE.SetConfig', {
          config: { enable: true, rpc: { enable: true }, observer: { enable: true } }
        });
        console.log('✅ Bluetooth + observer enabled');
      }
    } catch (error) {
      console.error('Failed to check/enable BLE:', error.message);
    }
  }

  // ─── Script Deployment ──────────────────────────────────────────
  //
  // Core of the plug-and-play approach: push a BLE scanner script
  // to the gateway. Based on Shelly's official Script API:
  //   Script.Create → Script.PutCode → Script.SetConfig → Script.Start
  //

  /**
   * Get the URL our server is reachable at from the gateway's perspective.
   * Always prefer direct LAN IP when the gateway is on the same subnet —
   * this avoids going through ngrok/tunnels which adds latency and may
   * have path prefix issues.
   */
  getServerBleEndpoint() {
    // Find our LAN IP on the same subnet as the gateway
    const ifaces = os.networkInterfaces();
    let serverIp = null;
    let fallbackIp = null;
    const gwParts = this.gatewayIp ? this.gatewayIp.split('.').slice(0, 3).join('.') : null;

    for (const [, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const addrSubnet = addr.address.split('.').slice(0, 3).join('.');
          if (gwParts && addrSubnet === gwParts) {
            serverIp = addr.address;
            break;
          }
          if (!fallbackIp) {
            fallbackIp = addr.address;
          }
        }
      }
      if (serverIp) break;
    }

    // If we found a same-subnet IP, always use it (direct LAN is fastest + most reliable)
    if (serverIp) {
      const port = process.env.PORT || 3001;
      return `http://${serverIp}:${port}/api/shelly/ble/data`;
    }

    // No same-subnet IP found — try a public app/tunnel URL as fallback
    const publicBaseUrl = getShellyPublicBaseUrl();
    if (publicBaseUrl) {
      return `${publicBaseUrl.origin}/api/shelly/ble/data`;
    }

    // Last resort: use any available IP
    const port = process.env.PORT || 3001;
    return `http://${fallbackIp || '127.0.0.1'}:${port}/api/shelly/ble/data`;
  }

  /**
   * Deploy the BLE scanner script to the gateway.
   * Idempotent: checks if already deployed, updates if code changed.
   */
  async deployBLEScript() {
    if (!this.initialized || !this.gatewayIp) {
      throw new Error('Gateway not initialized');
    }

    console.log('📜 Deploying BLE scanner script to gateway...');

    const serverUrl = this.getServerBleEndpoint();
    console.log(`   Server endpoint: ${serverUrl}`);

    try {
      // Check if our script already exists
      const scriptList = await this.rpcCall('Script.List');
      const scripts = scriptList.scripts || [];
      let existingScript = scripts.find(s => s.name === SCRIPT_NAME);

      if (existingScript) {
        this.scriptId = existingScript.id;
        console.log(`   Found existing script id=${this.scriptId}, running=${existingScript.running}`);

        // Stop if running so we can update
        if (existingScript.running) {
          await this.rpcPost('Script.Stop', { id: this.scriptId });
          console.log('   Stopped existing script for update');
        }
      } else {
        // Create new script slot
        const createResult = await this.rpcPost('Script.Create', { name: SCRIPT_NAME });
        this.scriptId = createResult.id;
        console.log(`   Created script id=${this.scriptId}`);
      }

      const cloudWebhookUrl = getShellyFirebaseWebhookUrl();
      if (!cloudWebhookUrl || /localhost|127\.0\.0\.1/i.test(cloudWebhookUrl)) {
        throw new Error(
          'CLOUD_WEBHOOK_REQUIRED: Set SHELLY_WEBHOOK_URL / BACKEND_PUBLIC_URL to the Cloud Run '
          + '/api/shelly/webhook endpoint before deploying the BLE scanner. Local-only URLs cannot '
          + 'collect H&T history when the laptop is offline.',
        );
      }
      const code = generateBLEScannerScript(serverUrl, cloudWebhookUrl);
      
      // Script.PutCode has size limits — upload in chunks
      const CHUNK_SIZE = 1024;
      for (let offset = 0; offset < code.length; offset += CHUNK_SIZE) {
        const chunk = code.slice(offset, offset + CHUNK_SIZE);
        await this.rpcPost('Script.PutCode', {
          id: this.scriptId,
          code: chunk,
          append: offset > 0,
        });
      }
      console.log(`   Uploaded ${code.length} bytes of script code`);

      // Enable auto-start on reboot
      await this.rpcPost('Script.SetConfig', {
        id: this.scriptId,
        config: { enable: true },
      });

      // Start the script now
      await this.rpcPost('Script.Start', { id: this.scriptId });
      this.scriptDeployed = true;
      console.log('✅ BLE scanner script deployed and running on gateway');
      console.log(`   Primary (Cloud Run history): ${cloudWebhookUrl}`);
      console.log(`   Secondary (local optional): ${serverUrl}`);

      return {
        success: true,
        scriptId: this.scriptId,
        serverUrl,
        cloudWebhookUrl,
        scriptVersion: 'v3.2',
      };
    } catch (error) {
      console.error('❌ Failed to deploy BLE script:', error.message);
      throw error;
    }
  }

  /**
   * Confirm the on-device script still points at Cloud Run. Redeploy if it still
   * lacks the current collector identity or points at a non-Cloud URL.
   */
  async ensureCloudPrimaryWebhook() {
    if (!this.initialized || !this.gatewayIp) {
      return { ok: false, reason: 'gateway_not_local' };
    }
    const cloudWebhookUrl = getShellyFirebaseWebhookUrl();
    if (!cloudWebhookUrl || /localhost|127\.0\.0\.1/i.test(cloudWebhookUrl)) {
      return { ok: false, reason: 'cloud_webhook_unconfigured' };
    }

    try {
      const scriptList = await this.rpcCall('Script.List');
      const scripts = scriptList.scripts || [];
      const existing = scripts.find((s) => s.name === SCRIPT_NAME);
      if (!existing) {
        const deployed = await this.deployBLEScript();
        return { ok: true, action: 'deployed_missing', ...deployed };
      }

      const codeResult = await this.rpcCall('Script.GetCode', { id: existing.id });
      const code = String(codeResult?.data || codeResult?.code || '');
      const hasCloudUrl = code.includes(cloudWebhookUrl) || code.includes('/api/shelly/webhook');
      const hasRetry = code.includes('sendToCloud') && code.includes('try');
      const hasLongTimeout = code.includes('timeout:20') || code.includes('timeout: 20');
      const hasCurrentCollector = code.includes('houseyield-ble-v3.2');

      if (hasCloudUrl && hasRetry && hasLongTimeout && hasCurrentCollector) {
        return { ok: true, action: 'already_current', scriptId: existing.id, running: existing.running };
      }

      console.log('🔄 BLE scanner script outdated or missing Cloud Run primary — redeploying v3.2…');
      const deployed = await this.deployBLEScript();
      return { ok: true, action: 'redeployed', ...deployed };
    } catch (error) {
      console.warn('[BLU] ensureCloudPrimaryWebhook failed:', error.message);
      return { ok: false, reason: error.message };
    }
  }

  /**
   * Check if the BLE scanner script is running on the gateway.
   */
  async getScriptStatus() {
    if (!this.initialized || !this.gatewayIp) return null;

    try {
      const scriptList = await this.rpcCall('Script.List');
      const scripts = scriptList.scripts || [];
      const ourScript = scripts.find(s => s.name === SCRIPT_NAME);

      if (!ourScript) return { deployed: false, running: false };
      this.scriptId = ourScript.id;
      this.scriptDeployed = true;

      return {
        deployed: true,
        running: ourScript.running || false,
        id: ourScript.id,
        name: ourScript.name,
      };
    } catch (error) {
      return { deployed: false, running: false, error: error.message };
    }
  }

  /**
   * Remove the BLE scanner script from the gateway.
   */
  async removeBLEScript() {
    const status = await this.getScriptStatus();
    if (!status || !status.deployed) return;

    try {
      if (status.running) {
        await this.rpcPost('Script.Stop', { id: status.id });
      }
      await this.rpcPost('Script.Delete', { id: status.id });
      this.scriptDeployed = false;
      this.scriptId = null;
      console.log('🗑️  BLE scanner script removed from gateway');
    } catch (error) {
      console.error('Failed to remove script:', error.message);
    }
  }

  // ─── BLE Data Handling ──────────────────────────────────────────
  //
  // Called when the gateway script POSTs sensor data to our endpoint.
  // The data is already parsed BTHome from the script.
  //

  /**
   * Process incoming BLE sensor data from the gateway script.
   * Called by the POST /api/shelly/ble/data route handler.
   * 
   * NOTE (v3.0): The gateway script now sends data to Firebase Cloud Function
   * as the PRIMARY target. The local server is a secondary recipient for
   * real-time local use. We set skipFirestore=true on emitted events so that
   * shellyHTService doesn't create duplicate Firestore entries (Firebase
   * Cloud Function already stored the reading).
   * 
   * @param {Object} data - Parsed BTHome data with addr, rssi, etc.
   */
  handleBleData(data) {
    if (!data || !data.addr) return;

    const addr = data.addr.toLowerCase();
    const now = new Date();
    // Missing is not success. Old local-only scripts did not send this flag,
    // and treating `undefined` as a successful cloud write made local telemetry
    // look cloud-connected even though it stopped with the laptop.
    const skipFirestore = data.firebaseWriteSucceeded === true && data.source !== 'ble_gateway_fallback';

    // Merge with existing data (sensors may not send all fields every time)
    const existing = this.discoveredDevices.get(addr) || {};
    const device = {
      addr,
      name: data.name || existing.name || '',
      rssi: data.rssi,
      battery: data.battery !== undefined ? data.battery : existing.battery,
      temperature: data.temperature !== undefined ? data.temperature : existing.temperature,
      humidity: data.humidity !== undefined ? data.humidity : existing.humidity,
      illuminance: data.illuminance !== undefined ? data.illuminance : existing.illuminance,
      motion: data.motion !== undefined ? data.motion : existing.motion,
      moisture: data.moisture !== undefined ? data.moisture : existing.moisture,
      window: data.window !== undefined ? data.window : existing.window,
      button: data.button !== undefined ? data.button : existing.button,
      pressure: data.pressure !== undefined ? data.pressure : existing.pressure,
      voltage: data.voltage !== undefined ? data.voltage : existing.voltage,
      pid: data.pid,
      lastSeen: now,
      firstSeen: existing.firstSeen || now,
      updateCount: (existing.updateCount || 0) + 1,
    };

    this.discoveredDevices.set(addr, device);

    // Emit typed events for downstream consumers.
    // skipFirestore=true because the Cloud Function already stored the reading.
    if (data.temperature !== undefined) {
      this.emit('sensor:temperature', {
        addr,
        temperature: data.temperature,
        timestamp: now,
        skipFirestore,
        source: data.source || 'ble_gateway',
      });
    }
    if (data.humidity !== undefined) {
      this.emit('sensor:humidity', {
        addr,
        humidity: data.humidity,
        timestamp: now,
        skipFirestore,
        source: data.source || 'ble_gateway',
      });
    }
    if (data.battery !== undefined) {
      this.emit('sensor:battery', {
        addr,
        battery: data.battery,
        timestamp: now,
        skipFirestore,
        source: data.source || 'ble_gateway',
      });
    }

    this.emit('sensor:update', {
      ...device,
      skipFirestore,
      source: data.source || 'ble_gateway',
    });

    void this.persistBleToCloud(device, data, skipFirestore);
  }

  /**
   * Always mirror BLE presence into IoT Firestore so the dashboard stays
   * current even when we skip duplicate sensor_readings locally.
   */
  async persistBleToCloud(device, data, skipFullReading) {
    const fallbackDeviceId = device?.addr
      ? `blu-ht-${String(device.addr).replace(/:/g, '').trim().toLowerCase()}`
      : 'unknown';

    try {
      const {
        bleAddrToCloudDeviceId,
        touchCloudDevicePresence,
        saveCloudSensorReading,
      } = await import('../iot-cloud-firestore.js');

      const deviceId = bleAddrToCloudDeviceId(device.addr);
      if (!deviceId) return;

      const tempC = device.temperature;
      const fields = {
        bleAddress: device.addr,
        type: 'temperature_humidity',
        deviceType: 'shelly_ht_gen3',
        model: 'BLU H&T',
        connectionType: 'bluetooth',
        capabilities: ['temperature', 'humidity', 'battery'],
        status: 'online',
        lastLocalIngestAt: new Date().toISOString(),
        lastIngestSource: data.source || 'ble_gateway_local',
        cloudDeliveryConfirmed: data.firebaseWriteSucceeded === true,
        collectorVersion: data.collectorVersion || null,
      };
      if (tempC != null) {
        fields.temperature = tempC;
        fields.temperatureF = (tempC * 9) / 5 + 32;
      }
      if (device.humidity != null) fields.humidity = device.humidity;
      // Only persist battery when THIS packet included it — otherwise we keep
      // rewriting an install-time 100% on every temp/humidity advertisement.
      if (data.battery !== undefined && data.battery != null) {
        fields.batteryPercent = data.battery;
        fields.batteryLevel = data.battery;
        fields.batteryUpdatedAt = new Date().toISOString();
      }

      // Always refresh live device presence.
      await touchCloudDevicePresence(deviceId, fields);

      // History for Analytics charts lives in IoT sensor_readings. When Firebase
      // already accepted the packet we used to skip local history writes — that
      // left the Conditions chart with almost no points. Throttle a dual-write
      // so charts fill without flooding Firestore on every ~11s BLE advert.
      const nowMs = Date.now();
      const lastHistory = this._lastHistoryWriteAt.get(deviceId) || 0;
      const shouldWriteHistory = !skipFullReading
        || (nowMs - lastHistory >= this.historyWriteIntervalMs);
      const hasMetrics = tempC != null || device.humidity != null;

      if (shouldWriteHistory && hasMetrics) {
        this._lastHistoryWriteAt.set(deviceId, nowMs);
        await saveCloudSensorReading(deviceId, {
          temperature: tempC ?? null,
          temperatureF: tempC != null ? (tempC * 9) / 5 + 32 : null,
          humidity: device.humidity ?? null,
          batteryPercent: data.battery !== undefined ? data.battery : null,
          bleAddress: device.addr,
          source: skipFullReading ? 'ble_gateway_history' : (data.source || 'ble_gateway_fallback'),
        });
      }

      const gatewayDocId = this.gatewayId
        || (this.gatewayIp ? `shellyblugw-${this.gatewayIp.replace(/\./g, '')}` : null);
      if (gatewayDocId) {
        await touchCloudDevicePresence(gatewayDocId, {
          type: 'ble_gateway',
          connectionType: 'wifi',
          localIp: this.gatewayIp,
          ip: this.gatewayIp,
          lastLocalIngestAt: new Date().toISOString(),
          lastIngestSource: data.source || 'ble_gateway_local',
          cloudDeliveryConfirmed: data.firebaseWriteSucceeded === true,
          collectorVersion: data.collectorVersion || null,
        });
      }
    } catch (error) {
      console.warn(`[BLU] IoT Firestore sync failed for ${fallbackDeviceId}:`, error.message);
    }
  }

  // ─── Discovery (Script-based passive scanning) ──────────────────
  //
  // Instead of BTHome.StartDeviceDiscovery (requires newer firmware),
  // the script's passive BLE scanning discovers devices automatically
  // as they broadcast. No explicit "start discovery" needed.
  //

  /**
   * Start BLE device discovery.
   * Ensures the scanner script is deployed and waits for broadcasts.
   * @param {number} waitSeconds - How long to collect broadcasts
   */
  async discoverDevices(waitSeconds = 15) {
    if (!this.initialized) {
      throw new Error('Gateway not initialized');
    }

    this.isDiscovering = true;
    console.log(`🔍 BLE discovery active (waiting ${waitSeconds}s for broadcasts)...`);

    // Ensure script is deployed and running
    const scriptStatus = await this.getScriptStatus();
    if (!scriptStatus || !scriptStatus.running) {
      console.log('   Script not running, deploying...');
      await this.deployBLEScript();
    }

    // Prune stale entries (older than 2 min)
    const cutoff = Date.now() - 120000;
    for (const [addr, dev] of this.discoveredDevices) {
      if (dev.lastSeen && dev.lastSeen.getTime() < cutoff) {
        this.discoveredDevices.delete(addr);
      }
    }

    // Wait for broadcasts to arrive from the gateway script
    return new Promise((resolve) => {
      setTimeout(() => {
        this.isDiscovering = false;
        const devices = Array.from(this.discoveredDevices.values());
        console.log(`✅ Discovery complete. ${devices.length} device(s) found`);
        resolve(devices);
      }, waitSeconds * 1000);
    });
  }

  /**
   * Get all currently known BLE devices (from passive scanning).
   */
  getDiscoveredDevices() {
    return Array.from(this.discoveredDevices.values());
  }

  // ─── Gateway Status ─────────────────────────────────────────────

  /**
   * Get the full status of the gateway including script state.
   */
  async getGatewayStatus() {
    if (!this.initialized || !this.gatewayIp) return null;

    try {
      const status = await this.rpcCall('Shelly.GetStatus');
      const scriptStatus = await this.getScriptStatus();

      return {
        online: true,
        ip: this.gatewayIp,
        wifi: status.wifi || {},
        ble: status.ble || {},
        sys: status.sys || {},
        uptime: status.sys?.uptime || 0,
        ramFree: status.sys?.ram_free || 0,
        script: scriptStatus,
        discoveredDevices: this.discoveredDevices.size,
      };
    } catch (error) {
      return {
        online: false,
        ip: this.gatewayIp,
        error: error.message,
        discoveredDevices: 0,
      };
    }
  }

  /**
   * Health check for the gateway.
   */
  async healthCheck() {
    if (!this.gatewayIp && !this.gatewayId) {
      return {
        status: 'not_configured',
        message: 'BLU Gateway not configured (set SHELLY_BLU_GATEWAY_IP)',
        configured: false,
      };
    }

    try {
      const status = await this.getGatewayStatus();
      return {
        status: status?.online ? 'ok' : 'offline',
        message: status?.online 
          ? `BLU Gateway online at ${this.gatewayIp}` 
          : 'Gateway unreachable',
        configured: true,
        ip: this.gatewayIp,
        scriptDeployed: status?.script?.deployed || false,
        scriptRunning: status?.script?.running || false,
        discoveredDevices: status?.discoveredDevices || 0,
        uptime: status?.uptime || 0,
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        configured: true,
      };
    }
  }

  /**
   * Handle incoming webhook events from the gateway (legacy support).
   */
  handleWebhookEvent(event) {
    const { component, data, ts } = event;
    if (!component || !data) return;

    if (component.startsWith('bthomesensor:') || component.startsWith('bthomedevice:')) {
      const sensorData = {
        component,
        timestamp: ts ? new Date(ts * 1000) : new Date(),
        ...data,
      };
      this.emit('sensor:update', sensorData);
    }
  }

  /**
   * Poll the gateway for sensor readings (fallback).
   */
  async pollAllSensors() {
    if (!this.initialized || !this.gatewayIp) return [];

    try {
      const status = await this.rpcCall('Shelly.GetStatus');
      const readings = [];

      for (const [key, value] of Object.entries(status)) {
        if (key.startsWith('temperature:') && value && typeof value === 'object') {
          readings.push({ type: 'temperature', componentId: key, tC: value.tC, tF: value.tF, timestamp: new Date() });
        }
        if (key.startsWith('humidity:') && value && typeof value === 'object') {
          readings.push({ type: 'humidity', componentId: key, rh: value.rh, timestamp: new Date() });
        }
        if (key.startsWith('bthomesensor:') && value && typeof value === 'object') {
          readings.push({ type: 'bthome_sensor', componentId: key, value: value.value, timestamp: new Date() });
        }
      }

      return readings;
    } catch (error) {
      console.error('Failed to poll sensors:', error.message);
      return [];
    }
  }

  // ─── Shutdown ───────────────────────────────────────────────────

  shutdown() {
    this.initialized = false;
    this._localConnected = false;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this.discoveredDevices.clear();
    console.log('🔌 BLU Gateway service shut down');
  }
}

export default new ShellyBluGateway();
