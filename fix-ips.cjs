const admin = require('./backend/config/firebase-config.cjs');
const db = admin.db;
const FieldValue = require('firebase-admin').firestore.FieldValue;

async function main() {
  // Fix H&T sensor IP
  await db.collection('shelly_devices').doc('shellyhtg3-d0cf13c27f04').update({
    ip: '192.168.1.193',
    localIp: '192.168.1.193',
    previousIp: '172.20.10.11',
    wifiSsid: 'Fios-Gk7TK',
    type: 'ht',
    deviceType: 'shelly_ht',
    lastSeen: FieldValue.serverTimestamp(),
    reconnectedAt: FieldValue.serverTimestamp(),
  });
  console.log('✅ H&T sensor IP updated: 172.20.10.11 → 192.168.1.193');

  // Fix BLU Gateway IP too
  await db.collection('shelly_devices').doc('shellyblugw-fcb467005fe4').update({
    ip: '192.168.1.191',
    localIp: '192.168.1.191',
    previousIp: '172.20.10.9',
    wifiSsid: 'Fios-Gk7TK',
    lastSeen: FieldValue.serverTimestamp(),
    reconnectedAt: FieldValue.serverTimestamp(),
  });
  console.log('✅ BLU Gateway IP updated: 172.20.10.9 → 192.168.1.191');

  // Verify
  const htDoc = await db.collection('shelly_devices').doc('shellyhtg3-d0cf13c27f04').get();
  const gwDoc = await db.collection('shelly_devices').doc('shellyblugw-fcb467005fe4').get();
  console.log('');
  console.log('H&T sensor:', htDoc.data().ip, '| type:', htDoc.data().type, '| deviceType:', htDoc.data().deviceType);
  console.log('BLU Gateway:', gwDoc.data().ip, '| type:', gwDoc.data().deviceType);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
