const admin = require('firebase-admin');
const path = require('path');

const sa = require(path.join(__dirname, 'backend', 'config', 'firebase-service-account.json'));

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id
  });
}
const db = admin.firestore();

async function main() {
  try {
    const all = await db.collection('renovation_uplift_results').get();
    console.log('Total docs in renovation_uplift_results:', all.size);
    let ct = 0;
    for (const doc of all.docs) {
      if (doc.id.startsWith('20906_')) {
        await doc.ref.delete();
        ct++;
        console.log('  Deleted:', doc.id);
      }
    }
    console.log('Deleted', ct, 'uplift results');
    
    await db.collection('renovation_area_summaries_v2').doc('20906').delete().catch(function() {});
    console.log('Deleted area summary v2');
    
    await db.collection('renovation_processing_log_v2').doc('20906').delete().catch(function() {});
    console.log('Deleted processing log v2');
    
    await db.collection('regional_uplift_analysis').doc('20906').delete().catch(function() {});
    console.log('Deleted old regional_uplift_analysis');
    
    console.log('Cleanup complete');
  } catch(e) {
    console.error('Error:', e.message);
  }
  process.exit(0);
}

main();
