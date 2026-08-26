require('dotenv').config();
const Replicate = require('replicate');
const r = new Replicate({auth: process.env.REPLICATE_API_KEY});

async function check(owner, name) {
  try {
    const m = await r.models.get(owner, name);
    const v = m.latest_version;
    console.log('✅', owner+'/'+name, '→', v ? v.id.substring(0,16) : 'no ver', '|', (m.description||'').substring(0,80));
  } catch(e) {
    console.log('❌', owner+'/'+name);
  }
}

(async () => {
  await check('stability-ai', 'stable-depth');
  await check('andreasjansson', 'depth-anything-v2');
  await check('depth-anything', 'depth-anything-v2-large');
  await check('thu-ml', 'depth-anything-v2');
  await check('depthpro', 'depth-pro');
  await check('apple', 'depth-pro');
  await check('fangchangma', 'zoedepth');
  await check('prs-eth', 'marigold');
  await check('prs-eth', 'marigold-lcm');
  await check('lemonaddie', 'geowizard');
  await check('filipstrand', 'depth-anything-v2');
  await check('nandovallec', 'depth-anything-v2');
  await check('baai', 'depth-anything-v2');
  await check('cjwbw', 'zoedepth');
  
  // Check zoedepth output schema to see if it returns metric
  try {
    const m = await r.models.get('cjwbw', 'zoedepth');
    const v = m.latest_version;
    if (v) {
      const schema = v.openapi_schema;
      const input = schema?.components?.schemas?.Input?.properties;
      if (input) {
        console.log('\nZoeDepth input params:', Object.keys(input).join(', '));
        for (const [k, v2] of Object.entries(input)) {
          console.log('  ', k, ':', v2.description || v2.type || JSON.stringify(v2).substring(0,80));
        }
      }
      const output = schema?.components?.schemas?.Output;
      if (output) {
        console.log('\nZoeDepth output:', JSON.stringify(output).substring(0,200));
      }
    }
  } catch(e) {
    console.log('Error getting zoedepth schema:', e.message);
  }
})();
