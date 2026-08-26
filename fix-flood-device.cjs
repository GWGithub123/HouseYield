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
    console.log(`Fixing Firestore doc for ${deviceId}...`);
    
    await db.collection('shelly_devices').doc(deviceId).update({
      type: 'flood',
      deviceType: 'flood',
      isFlooded: false,
      hasActiveAlert: false,
      capabilities: ['flood', 'temperature', 'battery'],
      updatedAt: new Date(),
    });

    console.log('✅ Fixed: type=flood, deviceType=flood, isFlooded=false, capabilities updated');

    // Verify
    const doc = await db.collection('shelly_devices').doc(deviceId).get();
    const d = doc.data();
    console.log('Verified: type=' + d.type + ' deviceType=' + d.deviceType + ' isFlooded=' + d.isFlooded);
    
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
