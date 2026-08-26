const admin = require('firebase-admin');
const sa = require('./backend/config/firebase-service-account.json');
if (admin.apps.length === 0) {
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();

async function main() {
  // Copy gateway from sensors to shelly_devices
  const gatewayDoc = await db.collection('sensors').doc('shellyblugw-fcb467005fe4').get();
  if (gatewayDoc.exists) {
    const data = gatewayDoc.data();
    await db.collection('shelly_devices').doc('shellyblugw-fcb467005fe4').set({
      ...data,
      deviceId: 'shellyblugw-fcb467005fe4',
      name: data.name || 'BLU Gateway',
      model: data.model || 'BLU Gateway GWF-KZ01',
      deviceType: 'ble_gateway',
      type: 'ble_gateway',
    }, { merge: true });
    console.log('Copied gateway to shelly_devices');
  } else {
    console.log('No gateway found in sensors collection');
  }

  // Verify
  const verify = await db.collection('shelly_devices').doc('shellyblugw-fcb467005fe4').get();
  console.log('Verified in shelly_devices:', verify.id, JSON.stringify(verify.data()));
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
