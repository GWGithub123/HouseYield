/**
 * Remote-capable Shelly relay / valve actuation.
 *
 * Priority:
 * 1. Outbound WebSocket (device connected to public HouseYield backend) — works from any network
 * 2. Local HTTP RPC when a reachable LAN IP is known
 */

import shellyLocalApi from './shellyLocalApi.js';
import shellyWsServer from './shellyWebSocketServer.js';

function normalizeAction(action) {
  return String(action || '').toLowerCase();
}

function resolveRelayOn(action, relayCloseOn = true) {
  const wantClose = normalizeAction(action) === 'close';
  return relayCloseOn ? wantClose : !wantClose;
}

async function verifyRelayIp(deviceId, ip, timeoutMs = 2000) {
  if (!ip) return null;
  try {
    const info = await shellyLocalApi.getDeviceInfo(ip, timeoutMs);
    if ((info.id || '').toLowerCase() === String(deviceId || '').toLowerCase()) {
      return ip;
    }
  } catch {
    // unreachable or stale IP
  }
  return null;
}

async function resolveReachableRelayIp(deviceId, candidateIps = []) {
  const uniqueCandidates = [...new Set(candidateIps.filter(Boolean))];
  for (const candidateIp of uniqueCandidates) {
    const verified = await verifyRelayIp(deviceId, candidateIp);
    if (verified) return verified;
  }

  try {
    const scannedIp = await shellyLocalApi.findDeviceOnNetwork(deviceId, null, 30);
    if (scannedIp) {
      return scannedIp;
    }
  } catch {
    // scan failed
  }

  return null;
}

async function actuateViaWebSocket(deviceId, action, options = {}) {
  if (!shellyWsServer.isDeviceConnected(deviceId)) {
    return null;
  }

  const relayOn = resolveRelayOn(action, options.relayCloseOn !== false);
  let setResult;
  try {
    // Require an RPC reply — an open socket alone is not proof the device is alive.
    // null means the socket vanished between the connected check and send.
    setResult = await shellyWsServer.sendRpcToDevice(
      deviceId,
      'Switch.Set',
      { id: options.switchId ?? 0, on: relayOn },
      5000,
    );
  } catch (error) {
    console.warn(`[Shelly Relay] WebSocket Switch.Set failed for ${deviceId}:`, error.message);
    try {
      shellyWsServer.forceDisconnect(deviceId, 'switch_set_failed');
    } catch {
      // ignore
    }
    return null;
  }

  if (setResult == null) {
    console.warn(`[Shelly Relay] WebSocket Switch.Set returned null for ${deviceId}`);
    try {
      shellyWsServer.forceDisconnect(deviceId, 'switch_set_null');
    } catch {
      // ignore
    }
    return null;
  }

  // Confirm the switch actually moved before claiming success.
  try {
    const status = await shellyWsServer.sendRpcToDevice(
      deviceId,
      'Switch.GetStatus',
      { id: options.switchId ?? 0 },
      4000,
    );
    if (status == null || typeof status.output !== 'boolean') {
      console.warn(`[Shelly Relay] WebSocket Switch.GetStatus missing output for ${deviceId}`);
      try {
        shellyWsServer.forceDisconnect(deviceId, 'switch_status_null');
      } catch {
        // ignore
      }
      return null;
    }
    const output = status.output === true;
    if (output !== relayOn) {
      console.warn(`[Shelly Relay] WebSocket Switch.Set did not stick for ${deviceId} (wanted ${relayOn}, got ${output})`);
      return null;
    }
    return {
      source: 'websocket',
      relayOutputOn: output,
      valveState: normalizeAction(action) === 'close' ? 'closed' : 'open',
      verified: true,
    };
  } catch (error) {
    console.warn(`[Shelly Relay] WebSocket Switch.GetStatus failed for ${deviceId}:`, error.message);
    try {
      shellyWsServer.forceDisconnect(deviceId, 'switch_status_failed');
    } catch {
      // ignore
    }
    return null;
  }
}

export async function actuateShellyRelay({
  deviceId,
  action,
  ip = null,
  candidateIps = [],
  actuationMode = 'maintained',
  pulseDurationMs = 20000,
  relayCloseOn = true,
  switchId = 0,
} = {}) {
  const normalizedAction = normalizeAction(action);
  if (!['open', 'close', 'pulse'].includes(normalizedAction)) {
    throw new Error('action must be one of open, close, or pulse');
  }

  const wsResult = await actuateViaWebSocket(deviceId, normalizedAction, {
    relayCloseOn,
    switchId,
  });
  if (wsResult) {
    return wsResult;
  }

  const deviceIp = await resolveReachableRelayIp(deviceId, [ip, ...candidateIps]);
  if (!deviceIp) {
    throw new Error(
      'Relay is not reachable remotely. Configure the Shelly relay with outbound WebSocket to your public HouseYield server, or connect the backend to the same network as the relay.',
    );
  }

  await shellyLocalApi.actuateValve(deviceIp, normalizedAction, {
    actuationMode,
    pulseDurationMs,
    relayCloseOn,
    switchId,
  });

  const relayStatus = await shellyLocalApi.getRelayStatus(deviceIp, switchId).catch(() => ({ output: false }));
  const relayOutputOn = relayStatus.output === true;
  const valveState = normalizedAction === 'pulse'
    ? 'unknown'
    : normalizedAction === 'close'
      ? 'closed'
      : 'open';

  return {
    source: 'local_http',
    ip: deviceIp,
    relayOutputOn,
    valveState,
  };
}

const RELAY_WS_WATCHDOG_SCRIPT = 'houseyield-ws-watchdog';

function buildRelayWsWatchdogScript(websocketUrl) {
  // Runs on the Shelly 1 Gen4. Re-enables outbound WS if Wi‑Fi flaps clear the config
  // or leave enable=false — common after travel-router 2.4 GHz restarts.
  return `// HouseYield outbound WS watchdog
let SERVER=${JSON.stringify(String(websocketUrl || ''))};
function ensure(){
  if(!SERVER||SERVER.length<8)return;
  Shelly.call("Ws.GetConfig",{},function(cfg,err){
    if(err!==0&&err!==undefined&&err!==null)return;
    let en=cfg&&cfg.enable===true;
    let srv=cfg&&cfg.server?String(cfg.server):"";
    if(en&&srv===SERVER)return;
    Shelly.call("Ws.SetConfig",{config:{enable:true,server:SERVER,ssl_ca:"*"}},function(_r,e){
      if(e===0)print("HY WS watchdog: re-enabled",SERVER);
    });
  });
}
Timer.set(120000,true,ensure);
ensure();
`;
}

async function installRelayWsWatchdog(deviceIp, websocketUrl, timeoutMs = 10000) {
  if (!websocketUrl) return null;
  const rpc = (method, params) => shellyLocalApi.rpc(deviceIp, method, params, timeoutMs);
  const list = await rpc('Script.List').catch(() => ({ scripts: [] }));
  const scripts = list.scripts || [];
  let existing = scripts.find((script) => script.name === RELAY_WS_WATCHDOG_SCRIPT);
  let scriptId = existing?.id;
  if (existing?.running) {
    await rpc('Script.Stop', { id: scriptId }).catch(() => {});
  }
  if (!scriptId) {
    const created = await rpc('Script.Create', { name: RELAY_WS_WATCHDOG_SCRIPT });
    scriptId = created.id;
  }
  const code = buildRelayWsWatchdogScript(websocketUrl);
  const CHUNK = 900;
  for (let offset = 0; offset < code.length; offset += CHUNK) {
    await rpc('Script.PutCode', {
      id: scriptId,
      code: code.slice(offset, offset + CHUNK),
      append: offset > 0,
    });
  }
  await rpc('Script.SetConfig', { id: scriptId, config: { enable: true } });
  await rpc('Script.Start', { id: scriptId });
  return { scriptId, name: RELAY_WS_WATCHDOG_SCRIPT };
}

export async function configureRelayCloudConnectivity(deviceIp, deviceId, options = {}) {
  const { webhookBaseUrl, websocketUrl, timeoutMs = 10000 } = options;
  const results = {
    websocket: null,
    webhooks: [],
    wsWatchdog: null,
  };

  if (websocketUrl) {
    try {
      await shellyLocalApi.rpc(deviceIp, 'Ws.SetConfig', {
        config: {
          enable: true,
          server: websocketUrl,
          ssl_ca: '*',
        },
      }, timeoutMs);
      results.websocket = websocketUrl;
    } catch (error) {
      console.warn('[Shelly Relay] Outbound WebSocket config failed:', error.message);
    }

    try {
      results.wsWatchdog = await installRelayWsWatchdog(deviceIp, websocketUrl, timeoutMs);
      console.log(`[Shelly Relay] WS watchdog installed on ${deviceIp}`);
    } catch (error) {
      console.warn('[Shelly Relay] WS watchdog install failed:', error.message);
    }
  }

  if (webhookBaseUrl && deviceId) {
    try {
      const hooks = await shellyLocalApi.rpc(deviceIp, 'Webhook.List', {}, timeoutMs).catch(() => ({ hooks: [] }));
      for (const hook of hooks.hooks || []) {
        await shellyLocalApi.rpc(deviceIp, 'Webhook.Delete', { id: hook.id }, timeoutMs).catch(() => {});
      }

      const statusUrl = `${webhookBaseUrl.split('?')[0]}?device_id=${encodeURIComponent(deviceId)}&event=relay.status`;
      await shellyLocalApi.rpc(deviceIp, 'Webhook.Create', {
        cid: 0,
        enable: true,
        event: 'switch.on',
        name: 'firebase_relay_on',
        urls: [statusUrl],
      }, timeoutMs);
      await shellyLocalApi.rpc(deviceIp, 'Webhook.Create', {
        cid: 0,
        enable: true,
        event: 'switch.off',
        name: 'firebase_relay_off',
        urls: [statusUrl],
      }, timeoutMs);
      results.webhooks.push('switch.on', 'switch.off');
    } catch (error) {
      console.warn('[Shelly Relay] Firebase relay webhooks failed:', error.message);
    }
  }

  return results;
}

export { resolveReachableRelayIp, verifyRelayIp };
