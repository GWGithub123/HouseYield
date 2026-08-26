const http = require('http');

const GW = '192.168.1.191';
const SCRIPT_ID = 1;
const FB_URL = process.env.SHELLY_FIREBASE_WEBHOOK_URL
  || 'https://us-central1-houseyield.cloudfunctions.net/shellyWebhook';
const LOCAL_URL = 'http://192.168.1.173:3001/api/shelly/ble/data';

const code = '// HouseYield BLE Sensor Scanner v3.0 — Firebase-primary, always-on\n' +
'let SERVER="' + LOCAL_URL + '";\n' +
'let FBURL="' + FB_URL + '";\n' +
'let BTHOME="fcd2";\n' +
'let U8=0;let I8=1;let U16=2;let I16=3;let U24=4;let I24=5;\n' +
'let BTH={\n' +
'0x00:{n:"pid",t:U8},\n' +
'0x01:{n:"battery",t:U8},\n' +
'0x02:{n:"temperature",t:I16,f:0.01},\n' +
'0x03:{n:"humidity",t:U16,f:0.01},\n' +
'0x05:{n:"illuminance",t:U24,f:0.01},\n' +
'0x0c:{n:"voltage",t:U16,f:0.001},\n' +
'0x14:{n:"moisture",t:U16,f:0.01},\n' +
'0x21:{n:"motion",t:U8},\n' +
'0x2d:{n:"window",t:U8},\n' +
'0x2e:{n:"humidity",t:U8},\n' +
'0x2f:{n:"moisture",t:U8},\n' +
'0x3a:{n:"button",t:U8},\n' +
'0x3f:{n:"rotation",t:I16,f:0.1},\n' +
'0x45:{n:"temperature",t:I16,f:0.1},\n' +
'0x04:{n:"pressure",t:U24,f:0.01},\n' +
'0x4a:{n:"voltage",t:U16,f:0.1},\n' +
'0x15:{n:"battery_ok",t:U8},\n' +
'0x06:{n:"weight",t:U16,f:0.01},\n' +
'0x09:{n:"count",t:U8},\n' +
'0x3d:{n:"count",t:U16},\n' +
'0x60:{n:"channel",t:U8}\n' +
'};\n' +
'function bsz(t){if(t===U8||t===I8)return 1;if(t===U16||t===I16)return 2;if(t===U24||t===I24)return 3;return 255;}\n' +
'let Dec={\n' +
'utoi:function(n,b){let m=1<<(b-1);return n&m?n-(1<<b):n;},\n' +
'u8:function(b){return b.at(0);},\n' +
'i8:function(b){return this.utoi(this.u8(b),8);},\n' +
'u16:function(b){return 0xffff&((b.at(1)<<8)|b.at(0));},\n' +
'i16:function(b){return this.utoi(this.u16(b),16);},\n' +
'u24:function(b){return(b.at(2)<<16)|(b.at(1)<<8)|b.at(0);},\n' +
'i24:function(b){return this.utoi(this.u24(b),24);},\n' +
'val:function(t,b){\n' +
'if(t===U8)return this.u8(b);if(t===I8)return this.i8(b);\n' +
'if(t===U16)return this.u16(b);if(t===I16)return this.i16(b);\n' +
'if(t===U24)return this.u24(b);if(t===I24)return this.i24(b);\n' +
'return null;\n' +
'},\n' +
'unpack:function(buf){\n' +
'if(typeof buf!=="string"||buf.length===0)return null;\n' +
'let r={};let d=buf.at(0);\n' +
'r.enc=d&0x1?true:false;\n' +
'r.v=d>>5;\n' +
'if(r.v!==2)return null;\n' +
'if(r.enc)return r;\n' +
'buf=buf.slice(1);\n' +
'let b,v;\n' +
'while(buf.length>0){\n' +
'b=BTH[buf.at(0)];\n' +
'if(typeof b==="undefined"){buf=buf.slice(1);continue;}\n' +
'buf=buf.slice(1);\n' +
'v=this.val(b.t,buf);\n' +
'if(v===null)break;\n' +
'if(typeof b.f!=="undefined")v=v*b.f;\n' +
'if(typeof r[b.n]==="undefined"){r[b.n]=v;}\n' +
'else if(Array.isArray(r[b.n])){r[b.n].push(v);}\n' +
'else{r[b.n]=[r[b.n],v];}\n' +
'buf=buf.slice(bsz(b.t));\n' +
'}\n' +
'return r;\n' +
'}\n' +
'};\n' +
'let lastPid={};\n' +
'let sendQ=[];\n' +
'let sending=false;\n' +
'let MAX_BUF=60;\n' +
'function mkId(d){return d.addr?"blu-ht-"+d.addr.split(":").join("").toLowerCase():"unknown";}\n' +
'function postData(d){\n' +
'sendQ.push(d);\n' +
'if(sendQ.length>MAX_BUF)sendQ.splice(0,sendQ.length-MAX_BUF);\n' +
'if(!sending)flush();\n' +
'}\n' +
'function sendToFirebase(d,cb){\n' +
'if(!FBURL||FBURL.length<10){if(cb)cb(false);return;}\n' +
'let id=mkId(d);\n' +
'let url=FBURL+"?device_id="+id+"&event=temperature_humidity&source=ble_gateway";\n' +
'if(typeof d.temperature!=="undefined")url+="&tC="+d.temperature+"&tF="+(d.temperature*9/5+32);\n' +
'if(typeof d.humidity!=="undefined")url+="&rh="+d.humidity;\n' +
'if(typeof d.battery!=="undefined")url+="&battery="+d.battery;\n' +
'let p={};\n' +
'if(typeof d.temperature!=="undefined")p.tC=d.temperature;\n' +
'if(typeof d.humidity!=="undefined")p.rh=d.humidity;\n' +
'if(typeof d.battery!=="undefined")p.battery=d.battery;\n' +
'let body=JSON.stringify({device_id:id,event:"temperature_humidity",src:id,params:p,source:"ble_gateway"});\n' +
'Shelly.call("HTTP.POST",{url:url,body:body,content_type:"application/json",timeout:10},\n' +
'function(r,e){\n' +
'if(e!==0){print("Firebase POST err:",e);if(cb)cb(false);}\n' +
'else{print("Firebase OK:",id);if(cb)cb(true);}\n' +
'});\n' +
'}\n' +
'function sendToLocal(d){\n' +
'if(!SERVER||SERVER.length<10)return;\n' +
'Shelly.call("HTTP.POST",{url:SERVER,body:JSON.stringify(d),content_type:"application/json",timeout:3},\n' +
'function(r,e){\n' +
'if(e!==0){print("Local server offline, Firebase-only mode");}\n' +
'else{print("Local OK");}\n' +
'});\n' +
'}\n' +
'function flush(){\n' +
'if(sendQ.length===0){sending=false;return;}\n' +
'sending=true;\n' +
'let d=sendQ.splice(0,1)[0];\n' +
'sendToFirebase(d,function(ok){\n' +
'let localPayload={};\n' +
'for(let k in d)localPayload[k]=d[k];\n' +
'localPayload.firebaseWriteSucceeded=ok;\n' +
'localPayload.source=ok?"ble_gateway":"ble_gateway_fallback";\n' +
'sendToLocal(localPayload);\n' +
'Timer.set(200,false,flush);\n' +
'});\n' +
'}\n' +
'function scanCB(ev,res){\n' +
'if(ev!==BLE.Scanner.SCAN_RESULT)return;\n' +
'if(typeof res.service_data==="undefined"||typeof res.service_data[BTHOME]==="undefined")return;\n' +
'let parsed=Dec.unpack(res.service_data[BTHOME]);\n' +
'if(parsed===null||parsed.enc)return;\n' +
'let addr=res.addr;\n' +
'let pid=parsed.pid;\n' +
'if(typeof pid!=="undefined"&&lastPid[addr]===pid)return;\n' +
'if(typeof pid!=="undefined")lastPid[addr]=pid;\n' +
'parsed.addr=addr;\n' +
'parsed.rssi=res.rssi;\n' +
'parsed.name=res.local_name||"";\n' +
'postData(parsed);\n' +
'print("BLE:",addr,JSON.stringify(parsed));\n' +
'}\n' +
'function init(){\n' +
'let c=Shelly.getComponentConfig("ble");\n' +
'if(!c.enable){print("BLE disabled!");return;}\n' +
'if(BLE.Scanner.isRunning()){\n' +
'print("Scanner running, subscribing");\n' +
'}else{\n' +
'let s=BLE.Scanner.Start({duration_ms:BLE.Scanner.INFINITE_SCAN,active:false});\n' +
'if(!s){print("Scan start failed");return;}\n' +
'print("Scanner started");\n' +
'}\n' +
'BLE.Scanner.Subscribe(scanCB);\n' +
'print("HouseYield BLE scanner v3 ready");\n' +
'print("Primary (Firebase):",FBURL);\n' +
'print("Secondary (local):",SERVER);\n' +
'}\n' +
'init();\n';

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: Date.now(), method, params });
    const req = http.request({
      hostname: GW, port: 80, path: '/rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(JSON.stringify(p.error)));
          else resolve(p.result);
        } catch(e) { reject(new Error(data.substring(0,200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Uploading v3.0 script (' + code.length + ' bytes) to gateway at ' + GW + '...');
  
  const CHUNK = 1024;
  for (let i = 0; i < code.length; i += CHUNK) {
    const chunk = code.slice(i, i + CHUNK);
    await rpc('Script.PutCode', { id: SCRIPT_ID, code: chunk, append: i > 0 });
    process.stdout.write('.');
  }
  console.log(' done');
  
  await rpc('Script.SetConfig', { id: SCRIPT_ID, config: { enable: true } });
  console.log('Auto-start enabled');
  
  await rpc('Script.Start', { id: SCRIPT_ID });
  console.log('v3.0 Script started!');
  console.log('Primary target:   ' + FB_URL);
  console.log('Secondary target: ' + LOCAL_URL);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
