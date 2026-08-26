const admin = require('firebase-admin');
const app = admin.apps.length 
  ? admin.app() 
  : admin.initializeApp({ 
      credential: admin.credential.cert(require('./backend/config/firebase-service-account.json')) 
    });
const db = admin.firestore();

(async () => {
  try {
    const deviceId = 'shellyfloodg4-48f6eed3c830';
    
    // 1. Full device doc — every field
    console.log('=== FLOOD DEVICE DOC (ALL FIELDS) ===');
    const dev = await db.collection('shelly_devices').doc(deviceId).get();
    if (dev.exists) {
      const dd = dev.data();
      for (const [k, v] of Object.entries(dd)) {
        if (v && typeof v.toDate === 'function') {
          console.log(`  ${k}: ${v.toDate().toISOString()}`);
        } else if (typeof v === 'object' && v !== null) {
          console.log(`  ${k}: ${JSON.stringify(v)}`);
        } else {
          console.log(`  ${k}: ${v}`);
        }
      }
    }

    // 2. Check ALL alerts from today to see if the test floods arrived
    console.log('\n=== ALERTS FROM LAST 24h ===');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const alertsSnap = await db.collection('alerts')
      .where('timestamp', '>=', yesterday)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();
    if (alertsSnap.empty) console.log('  (none in last 24h)');
    alertsSnap.forEach(doc => {
      const d = doc.data();
      console.log(`  ${doc.id} | ${d.type} | ${d.deviceId} | ${(d.message||'').substring(0,60)} | ts: ${d.timestamp?.toDate?.()?.toISOString()}`);
    });

    // 3. Check ALL sensor_webhooks from last 24h
    console.log('\n=== SENSOR WEBHOOKS LAST 24h ===');
    const swSnap = await db.collection('sensor_webhooks')
      .where('timestamp', '>=', yesterday)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();
    if (swSnap.empty) console.log('  (none in last 24h)');
    swSnap.forEach(doc => {
      const d = doc.data();
      console.log(`  ${d.deviceId} | ${d.event} | ts: ${d.timestamp?.toDate?.()?.toISOString()}`);
    });

    // 4. Check ALL raw_webhooks from last 24h
    console.log('\n=== RAW WEBHOOKS LAST 24h ===');
    const rwSnap = await db.collection('raw_webhooks')
      .where('timestamp', '>=', yesterday)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();
    if (rwSnap.empty) console.log('  (none in last 24h)');
    rwSnap.forEach(doc => {
      const d = doc.data();
      console.log(`  ${d.deviceId || 'unknown'} | ts: ${d.timestamp?.toDate?.()?.toISOString()}`);
      if (d.body) console.log(`    body: ${JSON.stringify(d.body).substring(0, 150)}`);
      if (d.query) console.log(`    query: ${JSON.stringify(d.query).substring(0, 150)}`);
    });

    // 5. Check if there are any other docs for this device ID in other collections
    console.log('\n=== OTHER COLLECTIONS ===');
    const collections = ['sensor_readings', 'sensor_events', 'device_configs'];
    for (const coll of collections) {
      try {
        const snap = await db.collection(coll)
          .where('deviceId', '==', deviceId)
          .limit(3)
          .get();
        console.log(`  ${coll}: ${snap.size} docs`);
        snap.forEach(doc => {
          const d = doc.data();
          const ts = d.timestamp?.toDate?.()?.toISOString() || d.createdAt?.toDate?.()?.toISOString() || 'no-ts';
          console.log(`    ts: ${ts} | keys: ${Object.keys(d).join(', ')}`);
        });
      } catch (e) {
        console.log(`  ${coll}: ${e.message.substring(0, 80)}`);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
