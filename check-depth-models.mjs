import 'dotenv/config';
import Replicate from 'replicate';
const r = new Replicate({auth: process.env.REPLICATE_API_KEY});

const models = [
  ['adirik', 'depth-pro'],
  ['cjwbw', 'metric3d-vit-large'],
  ['adirik', 'depth-anything-v2'],
  ['adirik', 'unidepth-v2'],
  ['ibaiGorordo', 'metric3d-v2'],
  ['lucataco', 'depth-pro'],
  ['antoinelyset', 'depth-pro'],
  ['tencent', 'depth-pro'],
  ['cjwbw', 'zoedepth'],
  ['zhyever', 'metric3d'],
  ['zhyever', 'metric-3d-v2'],
  ['cjwbw', 'metric3d'],
];

for (const [owner, name] of models) {
  try {
    const m = await r.models.get(owner, name);
    console.log(`✅ ${owner}/${name}`);
    console.log(`   version: ${m.latest_version?.id}`);
    console.log(`   desc: ${(m.description || '').substring(0, 100)}`);
    console.log();
  } catch(e) {
    console.log(`❌ ${owner}/${name}: ${e.message?.substring(0, 80)}`);
  }
}
